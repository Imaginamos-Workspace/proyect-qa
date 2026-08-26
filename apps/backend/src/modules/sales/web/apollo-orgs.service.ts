import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../config/supabase.module';
import { normalizeDomain } from './scraper.utils';
import type { ApolloOrg } from '../../../shared-types/sales.types';

/**
 * Búsqueda de EMPRESAS en Apollo (`/v1/organizations/search`).
 *
 * Este endpoint SÍ está disponible en el plan Free — a diferencia de
 * `mixed_people/api_search`, `people/match`, `mixed_companies/search` y
 * `organizations/enrich`, que devuelven 403 API_INACCESSIBLE (medido con la
 * key real el 2026-08-19). Por eso el módulo dejó de poder buscar personas
 * pero sí puede buscar empresas, gratis.
 *
 * Complementa al registro público (OpenDataService), que aporta lo que Apollo
 * no tiene y viceversa:
 *
 *   registro público  →  NIT, teléfono local, correo, dirección oficial
 *   Apollo            →  industria real, tamaño (empleados), LinkedIn, web
 *
 * OJO con la URL: `organizations/search` responde tanto en `/v1/...` como en
 * `/api/v1/...`; los endpoints de personas SOLO en `/api/v1/...`. Se usa la
 * forma con `/api` para que sea una sola base para todo.
 */

const APOLLO_ORG_SEARCH_URL = 'https://api.apollo.io/api/v1/organizations/search';
const TIMEOUT_MS = 30_000;
const PER_PAGE = 25;

const CACHE_TABLE = 'sales_apollo_orgs';
const SYNC_LOG_TABLE = 'sales_apollo_sync_log';

/** Presupuesto de la corrida semanal. La función serverless tiene 60s, así
 *  que se corta por tiempo Y por cantidad de llamadas: lo que no entra queda
 *  para la semana siguiente (el catálogo es acumulativo). */
const SYNC_PRESUPUESTO_MS = 45_000;
const SYNC_MAX_CALLS = 30;
/** Pausa entre llamadas — cortesía con la API y evita el 429. */
const SYNC_PAUSA_MS = 500;

/** Segmentación por tamaño — los rangos son los que acepta Apollo en
 *  `organization_num_employees_ranges` ("min,max"). */
export const SEGMENTS = [
  { range: '1,50', label: 'Startup' },
  { range: '51,500', label: 'SMB' },
  { range: '501,5000', label: 'Enterprise' },
] as const;

/** Derivar el segmento del headcount real que devuelve Apollo, que puede no
 *  coincidir con el rango pedido (Apollo es laxo con los bordes). */
export function segmentFor(employees: number): string {
  if (employees <= 50) return 'Startup';
  if (employees <= 500) return 'SMB';
  return 'Enterprise';
}

/**
 * Países donde Imaginamos puede tener clientes: Latinoamérica, España y
 * Estados Unidos. Van en inglés porque es como Apollo indexa `organization_locations`.
 *
 * Colombia primero a propósito: es el mercado principal, y si una corrida se
 * corta por presupuesto conviene que lo ya cubierto sea lo más útil.
 */
export const COUNTRIES = [
  'Colombia',
  'Mexico',
  'Spain',
  'United States',
  'Panama',
  'Costa Rica',
  'Guatemala',
  'El Salvador',
  'Honduras',
  'Dominican Republic',
  'Ecuador',
  'Peru',
  'Chile',
  'Argentina',
  'Uruguay',
  'Paraguay',
  'Bolivia',
] as const;

/** Sets de palabras clave por industria, en español e inglés — Apollo indexa
 *  en ambos y las empresas colombianas aparecen escritas de las dos formas. */
export const KEYWORD_SETS: Record<string, string[]> = {
  seguros: ['insurance', 'seguros', 'aseguradora', 'insurtech'],
  fintech: ['fintech', 'financial services', 'financiero', 'credito'],
  banca: ['banking', 'banca', 'banco'],
  logistica: ['logistics', 'logistica'],
  retail: ['retail', 'comercio', 'ecommerce'],
  salud: ['salud', 'health', 'farmaceutica'],
  construccion: ['construccion', 'inmobiliaria', 'real estate'],
  educacion: ['educacion', 'education', 'universidad'],
  energia: ['energia', 'energy', 'oil'],
  transporte: ['transporte', 'transport', 'movilidad'],
  manufactura: ['manufactura', 'manufacturing', 'industrial'],
  agroindustria: ['agroindustria', 'agro', 'alimentos'],
  telecomunicaciones: ['telecomunicaciones', 'telecom'],
  turismo: ['turismo', 'hospitality', 'hoteleria'],
};

// El tipo vive en shared-types (lo consume el frontend).

interface ApolloOrgRaw {
  id?: string;
  name?: string;
  website_url?: string | null;
  primary_domain?: string | null;
  linkedin_url?: string | null;
  phone?: string | null;
  industry?: string | null;
  estimated_num_employees?: number | null;
  city?: string | null;
  country?: string | null;
  founded_year?: number | null;
  short_description?: string | null;
}

@Injectable()
export class ApolloOrgsService {
  private readonly logger = new Logger(ApolloOrgsService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get apiKey(): string | null {
    return process.env.APOLLO_API_KEY?.trim().replace(/^["']|["']$/g, '') || null;
  }

  status(): { configured: boolean } {
    return { configured: !!this.apiKey };
  }

  /**
   * Busca empresas por palabras clave, ubicación y rango de tamaño.
   *
   * @param keywords van a `q_organization_keyword_tags` (etiquetas de Apollo),
   *        no a `q_organization_name`: buscar por etiqueta trae el sector
   *        entero, buscar por nombre solo trae las que lo llevan en la razón
   *        social.
   */
  async search(
    keywords: string[],
    locations: string[] = ['Colombia'],
    employeeRanges: string[] = [],
    page = 1,
  ): Promise<{ orgs: ApolloOrg[]; total: number; page: number }> {
    const key = this.apiKey;
    if (!key) throw new BadRequestException('Falta configurar APOLLO_API_KEY en el backend.');

    const tags = keywords.map((k) => k.trim()).filter(Boolean);
    if (!tags.length) throw new BadRequestException('Da al menos una palabra clave.');

    const body: Record<string, unknown> = {
      per_page: PER_PAGE,
      page: Math.max(1, Math.trunc(page)),
      q_organization_keyword_tags: tags,
    };
    if (locations.length) body.organization_locations = locations;
    if (employeeRanges.length) body.organization_num_employees_ranges = employeeRanges;

    let res: Response;
    try {
      res = await fetch(APOLLO_ORG_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Apollo orgs no respondió: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Apollo no respondió. Intenta de nuevo.');
    }

    if (!res.ok) {
      const detalle = (await res.text().catch(() => '')).slice(0, 250);
      this.logger.error(`Apollo orgs ${res.status}: ${detalle}`);
      if (res.status === 429) {
        throw new ServiceUnavailableException('Apollo devolvió rate limit. Esperá un momento.');
      }
      throw new BadRequestException(`Apollo rechazó la búsqueda (${res.status}). ${detalle}`);
    }

    const data = (await res.json().catch(() => ({}))) as {
      organizations?: ApolloOrgRaw[];
      pagination?: { total_entries?: number; page?: number };
    };

    const orgs = (data.organizations ?? []).map((o) => this.toOrg(o)).filter((o) => !!o.name);
    return {
      orgs,
      total: data.pagination?.total_entries ?? orgs.length,
      page: data.pagination?.page ?? page,
    };
  }

  private toOrg(o: ApolloOrgRaw): ApolloOrg {
    const website = o.website_url ?? null;
    const employees = o.estimated_num_employees ?? null;
    return {
      apolloId: o.id ?? null,
      name: (o.name ?? '').trim(),
      // primary_domain viene limpio; website_url trae protocolo y www.
      domain: o.primary_domain ? normalizeDomain(o.primary_domain) : website ? normalizeDomain(website) : null,
      website,
      industry: o.industry ?? null,
      employees,
      segment: employees != null ? segmentFor(employees) : null,
      linkedinUrl: o.linkedin_url ?? null,
      phone: o.phone ?? null,
      city: o.city ?? null,
      country: o.country ?? null,
      foundedYear: o.founded_year ?? null,
      description: (o.short_description ?? '').slice(0, 300) || null,
    };
  }

  // ── Lectura desde la CACHÉ (lo que usa la UI) ─────────────────────────────

  /**
   * Busca en el catálogo ya descargado. NO pega a Apollo: la API se consume
   * solo en la corrida semanal. Si acá no hay nada, el llamador cae al
   * registro público, que es gratis.
   */
  async searchCache(
    sector: string | null,
    segment: string | null,
    text: string | null,
    limit = 25,
  ): Promise<{ orgs: ApolloOrg[]; total: number; fromCache: true; lastSync: string | null }> {
    let q = this.supabase.from(CACHE_TABLE).select('*', { count: 'exact' });
    if (sector) q = q.eq('sector', sector);
    if (segment) q = q.eq('segment', segment);
    if (text?.trim()) q = q.ilike('name', `%${text.trim()}%`);

    const { data, count, error } = await q
      .order('employees', { ascending: false, nullsFirst: false })
      .limit(Math.min(limit, 50));
    if (error) {
      this.logger.warn(`Caché de Apollo no disponible (¿migración 030?): ${error.message}`);
      return { orgs: [], total: 0, fromCache: true, lastSync: null };
    }

    const { data: ultima } = await this.supabase
      .from(CACHE_TABLE)
      .select('fetched_at')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      orgs: (data ?? []).map((r) => this.fromRow(r as Record<string, unknown>)),
      total: count ?? 0,
      fromCache: true,
      lastSync: (ultima?.fetched_at as string) ?? null,
    };
  }

  // ── Corrida SEMANAL (lo único que pega a Apollo) ──────────────────────────

  /**
   * Recorre los sectores × segmentos y va llenando el catálogo. Acotada por
   * tiempo y por número de llamadas: el catálogo es acumulativo, así que no
   * hace falta terminar todo en una corrida.
   */
  /**
   * Barrido semanal: recorre PAÍS × SECTOR y va llenando el catálogo.
   *
   * 17 países × 14 sectores = 238 combinaciones, y en el presupuesto de 45s
   * entran ~30 llamadas. Por eso el barrido es ROTATIVO: cada corrida arranca
   * donde quedó la anterior (`next_index` en el log) y deja anotado el punto
   * siguiente. Un ciclo completo toma ~8 semanas y el catálogo es acumulativo.
   *
   * No se filtra por tamaño de empresa: el segmento se deriva del headcount
   * que Apollo ya devuelve, así que filtrar por rango triplicaría las
   * combinaciones sin aportar datos nuevos.
   */
  async refreshWeekly(): Promise<{ combos: number; calls: number; fetched: number; inserted: number; nextIndex: number }> {
    const sectores = Object.entries(KEYWORD_SETS);
    const combos: { pais: string; sector: string; keywords: string[] }[] = [];
    for (const pais of COUNTRIES) {
      for (const [sector, keywords] of sectores) combos.push({ pais, sector, keywords });
    }

    if (!this.apiKey) {
      await this.logSync({ calls: 0, fetched: 0, inserted: 0, next_index: 0, error: 'APOLLO_API_KEY no configurada' });
      return { combos: 0, calls: 0, fetched: 0, inserted: 0, nextIndex: 0 };
    }

    const desde = await this.leerCursor(combos.length);
    const finAntesDe = Date.now() + SYNC_PRESUPUESTO_MS;
    let calls = 0, fetched = 0, inserted = 0, i = desde;
    const tocados: string[] = [];

    while (calls < SYNC_MAX_CALLS && Date.now() < finAntesDe) {
      const c = combos[i % combos.length];
      const r = await this.search(c.keywords, [c.pais], [], 1).catch((e: Error) => {
        this.logger.warn(`Apollo falló en ${c.pais}/${c.sector}: ${e.message}`);
        return null;
      });
      calls++;
      tocados.push(`${c.pais}/${c.sector}`);
      i++;
      await new Promise((res) => setTimeout(res, SYNC_PAUSA_MS));
      if (!r) continue;
      fetched += r.orgs.length;
      inserted += await this.upsertCache(r.orgs, c.sector);
    }

    const nextIndex = i % combos.length;
    await this.logSync({
      calls, fetched, inserted, next_index: nextIndex,
      combos: tocados.join(', ').slice(0, 2000),
    });
    this.logger.log(
      `Apollo semanal: ${calls} llamadas · ${fetched} empresas · ${inserted} guardadas · ` +
      `posición ${desde}→${nextIndex} de ${combos.length}`,
    );
    return { combos: combos.length, calls, fetched, inserted, nextIndex };
  }

  /** Dónde quedó el barrido anterior. Fail-soft: si el log no existe todavía
   *  (migración 034 sin correr) se empieza por el principio. */
  private async leerCursor(total: number): Promise<number> {
    const { data } = await this.supabase
      .from(SYNC_LOG_TABLE)
      .select('next_index')
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const n = Number(data?.next_index ?? 0);
    return Number.isFinite(n) && n >= 0 ? n % total : 0;
  }

  private async upsertCache(orgs: ApolloOrg[], sector: string): Promise<number> {
    const filas = orgs
      .filter((o) => o.apolloId)
      .map((o) => ({
        apollo_id: o.apolloId,
        name: o.name,
        domain: o.domain,
        website: o.website,
        industry: o.industry,
        employees: o.employees,
        segment: o.segment,
        linkedin_url: o.linkedinUrl,
        phone: o.phone,
        city: o.city,
        country: o.country,
        founded_year: o.foundedYear,
        description: o.description,
        sector,
        fetched_at: new Date().toISOString(),
      }));
    if (!filas.length) return 0;

    const { error } = await this.supabase.from(CACHE_TABLE).upsert(filas, { onConflict: 'apollo_id' });
    if (error) {
      this.logger.warn(`No se pudo escribir la caché: ${error.message}`);
      return 0;
    }
    return filas.length;
  }

  private async logSync(row: Record<string, unknown>): Promise<void> {
    await this.supabase.from(SYNC_LOG_TABLE).insert(row);
  }

  private fromRow(r: Record<string, unknown>): ApolloOrg {
    return {
      apolloId: r.apollo_id as string,
      name: r.name as string,
      domain: (r.domain as string | null) ?? null,
      website: (r.website as string | null) ?? null,
      industry: (r.industry as string | null) ?? null,
      employees: (r.employees as number | null) ?? null,
      segment: (r.segment as string | null) ?? null,
      linkedinUrl: (r.linkedin_url as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      foundedYear: (r.founded_year as number | null) ?? null,
      description: (r.description as string | null) ?? null,
    };
  }
}
