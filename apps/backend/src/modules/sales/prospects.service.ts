import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import type {
  ProspectInteraction,
  ProspectInteractionResultado,
  ProspectInteractionTipo,
  SalesProspect,
  SalesProspectSearchInput,
  SalesProspectSearchResult,
  SalesProspectsStatus,
  SavedProspect,
  SavedProspectEstado,
  SavedProspectSearch,
  ProspectTlReview,
} from '../../shared-types/sales.types';

const PROSPECTS_TABLE = 'sales_prospects';
const INTERACTIONS_TABLE = 'sales_prospect_interactions';
const SEARCHES_TABLE = 'sales_prospect_searches';
const TL_REVIEWS_TABLE = 'sales_prospect_tl_reviews';

// La bitácora YA NO mueve la tarjeta. Registrar una llamada es registrar una
// llamada; si el negocio avanzó, el vendedor lo dice moviendo la tarjeta o
// con el desplegable del card — un solo vocabulario, una sola acción
// explícita. Antes había dos listas compitiendo (columnas vs. resultados del
// intento) y la tarjeta saltaba a una columna que nadie había elegido.

/** Tras 3 "sin respuesta" SEGUIDOS se le SUGIERE al vendedor pasar a Frío.
 *  Se sugiere, no se aplica: mover la tarjeta es decisión suya. */
const INTENTOS_ANTES_DE_FRIO = 3;

// Búsqueda de personas de Apollo.io. La key va en el header X-Api-Key y se
// configura SOLO como variable de entorno del backend (APOLLO_API_KEY) —
// nunca viaja al frontend ni se persiste en ningún lado.
// OJO: `mixed_people/search` da 403 API_INACCESSIBLE en varios planes;
// `api_search` es el habilitado (verificado con la key real 2026-07-09).
// Devuelve la vista OFUSCADA (last_name_obfuscated, solo flags has_email/
// has_*) — el dato completo sale de people/match (enrich, consume crédito).
const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match';
const APOLLO_TIMEOUT_MS = 15_000;
const PER_PAGE = 24;
// Tope defensivo por filtro — Apollo acepta listas largas pero acá nadie
// necesita más, y acota el tamaño del request.
const MAX_FILTER_ITEMS = 10;

// Shape mínimo que usamos de la respuesta de Apollo (el real trae mucho más).
// api_search ofusca: first_name + last_name_obfuscated y flags has_*;
// people/match (enrich) trae name/email/linkedin/location completos.
interface ApolloPerson {
  id?: string;
  name?: string;
  first_name?: string | null;
  last_name_obfuscated?: string | null;
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
  total_entries?: number;
  pagination?: { page?: number; total_pages?: number; total_entries?: number };
}

@Injectable()
export class ProspectsService {
  private readonly logger = new Logger(ProspectsService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get apiKey(): string | null {
    // Vercel guarda comillas/saltos de línea si la key se pega entrecomillada
    // (caso real con VITE_API_URL) — los quitamos antes de usarla.
    return process.env.APOLLO_API_KEY?.trim().replace(/^["']|["']$/g, '') || null;
  }

  /** ¿Está el flujo activo? El frontend usa esto para mostrar la guía de
   *  configuración en vez del buscador cuando falta la key. */
  status(): SalesProspectsStatus {
    return { configured: !!this.apiKey };
  }

  async search(input: SalesProspectSearchInput, requesterLogin: string | null = null): Promise<SalesProspectSearchResult> {
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
    const totalEntries = data.total_entries ?? data.pagination?.total_entries ?? people.length;
    const prospects = people.map((p) => this.toProspect(p)).filter((p): p is SalesProspect => !!p);

    // Idempotencia visible: qué resultados YA están guardados en el pipeline
    // del que busca (fail-soft si la migración 026 no corrió → []).
    let savedApolloIds: string[] = [];
    if (requesterLogin && prospects.length) {
      const { data: saved } = await this.supabase
        .from(PROSPECTS_TABLE)
        .select('apollo_id')
        .eq('vendedor_login', requesterLogin)
        .in('apollo_id', prospects.map((p) => p.id));
      savedApolloIds = (saved ?? []).map((r) => r.apollo_id as string);
    }

    return {
      prospects,
      page: data.pagination?.page ?? Number(body.page),
      totalPages: data.pagination?.total_pages ?? Math.max(1, Math.ceil(totalEntries / PER_PAGE)),
      totalEntries,
      savedApolloIds,
    };
  }

  /** Desbloquea el dato completo de un prospecto (people/match — consume 1
   *  crédito del plan): nombre real, email, LinkedIn, ubicación e industria.
   *  Se llama al elegir un prospecto, no en la búsqueda (economía de créditos). */
  async enrich(personId: string): Promise<SalesProspect> {
    const key = this.apiKey;
    if (!key) throw new BadRequestException('Falta configurar APOLLO_API_KEY en el backend.');

    let res: Response;
    try {
      res = await fetch(APOLLO_MATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
        body: JSON.stringify({ id: personId }),
        signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Apollo match no respondió: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Apollo.io no respondió al enriquecer el prospecto. Intenta de nuevo.');
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 250);
      this.logger.error(`Apollo match ${res.status}: ${detail}`);
      throw new BadRequestException(`Apollo no pudo enriquecer el prospecto (${res.status}). ${detail}`);
    }
    const data = (await res.json().catch(() => ({}))) as { person?: ApolloPerson };
    const prospect = data.person ? this.toProspect(data.person) : null;
    if (!prospect) throw new BadRequestException('Apollo no devolvió datos para ese prospecto.');
    return prospect;
  }

  // ── Pipeline de prospección (migración 026) ────────────────────────────

  /** Guarda un prospecto en el pipeline: enriquece (people/match, 1 crédito)
   *  y hace UPSERT por apollo_id — guardar dos veces (o que la corrida
   *  semanal lo vuelva a traer) NO duplica ni pisa el estado/notas.
   *
   *  `preview` son los datos que la búsqueda ya mostró en pantalla. Si el
   *  enriquecimiento falla (sin créditos, rate limit, API key, Apollo caído),
   *  el prospecto entra con esos datos en vez de quedar vacío. Antes el error
   *  se tragaba con un `.catch(() => null)` silencioso y la fila se insertaba
   *  toda en null devolviendo 201: el vendedor gastaba el clic y el prospecto
   *  aparecía como "(por confirmar) / Sin empresa" (bug 2026-07-30). */
  async saveProspect(
    apolloId: string,
    vendedorLogin: string,
    preview?: Partial<Omit<SalesProspect, 'id' | 'email'>>,
  ): Promise<SavedProspect> {
    const { data: existing } = await this.supabase
      .from(PROSPECTS_TABLE)
      .select('*')
      .eq('apollo_id', apolloId)
      .maybeSingle();
    if (existing) return this.toSaved(existing as Record<string, unknown>);

    // NO se enriquece al guardar: eso consumía 1 crédito por cada prospecto
    // que el vendedor guardaba, aunque nunca lo llamara. La regla es que a la
    // API de Apollo se le pega SOLO en la corrida semanal y en el botón
    // explícito "Desbloquear dato" (enrichSaved). Acá se persiste la vista
    // previa que la búsqueda ya mostró en pantalla.
    const { data, error } = await this.supabase
      .from(PROSPECTS_TABLE)
      .insert({
        apollo_id: apolloId,
        vendedor_login: vendedorLogin,
        origen: 'manual',
        name: preview?.name ?? '(por confirmar)',
        title: preview?.title ?? null,
        company: preview?.company ?? null,
        company_website: preview?.companyWebsite ?? null,
        industry: preview?.industry ?? null,
        location: preview?.location ?? null,
        linkedin_url: preview?.linkedinUrl ?? null,
        // El email lo trae el enriquecimiento explícito, que cuesta 1 crédito.
        email: null,
      })
      .select('*')
      .single();
    if (error) {
      // Carrera entre dos guardados simultáneos: el unique de apollo_id ganó.
      if (error.code === '23505') {
        const { data: raced } = await this.supabase.from(PROSPECTS_TABLE).select('*').eq('apollo_id', apolloId).single();
        return this.toSaved(raced as Record<string, unknown>);
      }
      throw new BadRequestException(`No se pudo guardar el prospecto (¿migración 026?): ${error.message}`);
    }
    return this.toSaved(data as Record<string, unknown>);
  }

  /** Desbloquea el dato completo de un prospecto YA guardado (los de la
   *  corrida semanal entran con la vista previa, sin email). Enriquece con
   *  people/match (1 crédito) y persiste SOLO los campos de Apollo — el
   *  teléfono/notas/estado que el vendedor ya nutrió no se tocan. */
  async enrichSaved(id: string, vendedorLogin: string): Promise<SavedProspect> {
    const current = await this.assertOwner(id, vendedorLogin);
    if (current.apolloId.startsWith('ref-')) {
      throw new BadRequestException('Este prospecto es un referido — no viene de Apollo, nutre sus datos a mano.');
    }
    const full = await this.enrich(current.apolloId);
    const { data, error } = await this.supabase
      .from(PROSPECTS_TABLE)
      .update({
        name: full.name,
        title: full.title,
        company: full.company ?? current.company,
        company_website: full.companyWebsite,
        industry: full.industry ?? current.industry,
        location: full.location,
        linkedin_url: full.linkedinUrl,
        email: full.email ?? current.email,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(`No se pudo actualizar el prospecto: ${error.message}`);
    return this.toSaved(data as Record<string, unknown>);
  }

  /** Pipeline del vendedor. Fail-soft sin migración 026 → []. */
  async listSaved(vendedorLogin: string | null): Promise<SavedProspect[]> {
    if (!vendedorLogin) return [];
    const { data, error } = await this.supabase
      .from(PROSPECTS_TABLE)
      .select('*')
      .eq('vendedor_login', vendedorLogin)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) return [];
    return (data ?? []).map((r) => this.toSaved(r as Record<string, unknown>));
  }

  /** Nutrir datos del prospecto (teléfono, email, notas, reintento, estado). */
  async updateProspect(
    id: string,
    vendedorLogin: string,
    patch: { estado?: SavedProspectEstado; notes?: string; phone?: string; email?: string; nextAttemptAt?: string | null; opportunityId?: string },
  ): Promise<SavedProspect> {
    await this.assertOwner(id, vendedorLogin);
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.estado !== undefined) update.estado = patch.estado;
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.phone !== undefined) update.phone = patch.phone;
    if (patch.email !== undefined) update.email = patch.email;
    if (patch.nextAttemptAt !== undefined) update.next_attempt_at = patch.nextAttemptAt;
    if (patch.opportunityId !== undefined) update.opportunity_id = patch.opportunityId;
    const { data, error } = await this.supabase
      .from(PROSPECTS_TABLE)
      .update(update)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(`No se pudo actualizar el prospecto: ${error.message}`);
    return this.toSaved(data as Record<string, unknown>);
  }

  /** Registra un intento de contacto. El estado del prospecto transiciona
   *  solo según el resultado; "referido" además CREA un prospecto nuevo con
   *  los datos de la persona referida (nutrición del pipeline). */
  async addInteraction(
    id: string,
    vendedorLogin: string,
    input: {
      tipo: ProspectInteractionTipo;
      resultado: ProspectInteractionResultado;
      notas?: string;
      referidoNombre?: string;
      referidoContacto?: string;
      reintentarAt?: string;
    },
  ): Promise<{ interaction: ProspectInteraction; prospect: SavedProspect; referral: SavedProspect | null }> {
    const owner = await this.assertOwner(id, vendedorLogin);
    const { data, error } = await this.supabase
      .from(INTERACTIONS_TABLE)
      .insert({
        prospect_id: id,
        vendedor_login: vendedorLogin,
        tipo: input.tipo,
        resultado: input.resultado,
        notas: input.notas ?? null,
        referido_nombre: input.referidoNombre ?? null,
        referido_contacto: input.referidoContacto ?? null,
        reintentar_at: input.reintentarAt ?? null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(`No se pudo registrar el intento: ${error.message}`);

    // Solo se guarda el reintento agendado: el ESTADO no se toca. Registrar
    // una llamada es registrar una llamada; si el negocio avanzó, el vendedor
    // lo dice moviendo la tarjeta o con el desplegable del card.
    const prospect = await this.updateProspect(id, vendedorLogin, {
      nextAttemptAt: input.reintentarAt ?? null,
    });

    // Sugerencia, no acción: 3 "sin respuesta" SEGUIDOS = candidato a Frío.
    // Mover la tarjeta sigue siendo decisión del vendedor.
    let sugerirFrio = false;
    if (input.resultado === 'sin-respuesta') {
      const { data: bitacora } = await this.supabase
        .from(INTERACTIONS_TABLE)
        .select('resultado')
        .eq('prospect_id', id)
        .order('created_at', { ascending: false })
        .limit(INTENTOS_ANTES_DE_FRIO);
      sugerirFrio =
        (bitacora ?? []).length >= INTENTOS_ANTES_DE_FRIO &&
        (bitacora ?? []).every((i) => i.resultado === 'sin-respuesta');
    }

    // Referido → prospecto nuevo en el pipeline, listo para contactar.
    let referral: SavedProspect | null = null;
    if (input.resultado === 'referido' && input.referidoNombre?.trim()) {
      const contacto = (input.referidoContacto ?? '').trim();
      const { data: ref } = await this.supabase
        .from(PROSPECTS_TABLE)
        .insert({
          apollo_id: `ref-${randomUUID()}`,
          vendedor_login: vendedorLogin,
          origen: 'referido',
          name: input.referidoNombre.trim(),
          company: owner.company,
          industry: owner.industry,
          email: contacto.includes('@') ? contacto : null,
          phone: contacto && !contacto.includes('@') ? contacto : null,
          notes: `Referido por ${owner.name}${input.notas ? ` — ${input.notas}` : ''}`,
        })
        .select('*')
        .single();
      if (ref) referral = this.toSaved(ref as Record<string, unknown>);
    }
    return { interaction: this.toInteraction(data as Record<string, unknown>), prospect, referral };
  }

  async listInteractions(id: string, vendedorLogin: string): Promise<ProspectInteraction[]> {
    await this.assertOwner(id, vendedorLogin);
    const { data } = await this.supabase
      .from(INTERACTIONS_TABLE)
      .select('*')
      .eq('prospect_id', id)
      .order('created_at', { ascending: false });
    return (data ?? []).map((r) => this.toInteraction(r as Record<string, unknown>));
  }

  // ── Búsquedas guardadas + corrida semanal ───────────────────────────────

  async createSavedSearch(
    vendedorLogin: string,
    input: { keywords?: string; titles?: string[]; locations?: string[]; source?: 'apollo' | 'web'; city?: string },
  ): Promise<SavedProspectSearch> {
    const { data, error } = await this.supabase
      .from(SEARCHES_TABLE)
      .insert({
        vendedor_login: vendedorLogin,
        keywords: (input.keywords ?? '').trim() || null,
        titles: input.titles ?? [],
        locations: input.locations ?? [],
        source: input.source ?? 'apollo',
        city: (input.city ?? '').trim() || null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(`No se pudo guardar la búsqueda (¿migración 026?): ${error.message}`);
    return this.toSearch(data as Record<string, unknown>);
  }

  async listSavedSearches(vendedorLogin: string | null): Promise<SavedProspectSearch[]> {
    if (!vendedorLogin) return [];
    const { data, error } = await this.supabase
      .from(SEARCHES_TABLE)
      .select('*')
      .eq('vendedor_login', vendedorLogin)
      .order('created_at', { ascending: false });
    if (error) return [];
    return (data ?? []).map((r) => this.toSearch(r as Record<string, unknown>));
  }

  async deleteSavedSearch(id: string, vendedorLogin: string): Promise<{ deleted: true }> {
    await this.supabase.from(SEARCHES_TABLE).delete().eq('id', id).eq('vendedor_login', vendedorLogin);
    return { deleted: true };
  }

  /** Corrida semanal (cron de Vercel): ejecuta cada búsqueda activa y guarda
   *  los prospectos NUEVOS como 'por-contactar' (origen semanal). Idempotente:
   *  el unique de apollo_id hace que lo ya guardado se salte sin tocar su
   *  estado/notas. Los nuevos NO se enriquecen acá (economía de créditos —
   *  el vendedor enriquece al abrir el que le interese... el guardado manual
   *  sí enriquece; acá se guarda la vista de búsqueda). */
  async runWeekly(): Promise<{ searches: number; found: number; inserted: number }> {
    const { data: searches, error } = await this.supabase
      .from(SEARCHES_TABLE)
      .select('*')
      .eq('active', true);
    if (error) return { searches: 0, found: 0, inserted: 0 };

    let found = 0;
    let inserted = 0;
    for (const s of searches ?? []) {
      const result = await this.search(
        { keywords: (s.keywords as string) ?? undefined, titles: (s.titles as string[]) ?? [], locations: (s.locations as string[]) ?? [], page: 1 },
        null,
      ).catch(() => null);
      if (!result) continue;
      found += result.prospects.length;
      for (const p of result.prospects) {
        const { error: insErr } = await this.supabase.from(PROSPECTS_TABLE).insert({
          apollo_id: p.id,
          vendedor_login: s.vendedor_login as string,
          origen: 'semanal',
          name: p.name,
          title: p.title,
          company: p.company,
          industry: p.industry,
        });
        if (!insErr) inserted++; // 23505 (duplicado) = ya estaba → idempotente
      }
      await this.supabase
        .from(SEARCHES_TABLE)
        .update({ last_run_at: new Date().toISOString() })
        .eq('id', s.id as string);
    }
    this.logger.log(`Corrida semanal de prospección: ${searches?.length ?? 0} búsquedas, ${found} resultados, ${inserted} nuevos.`);
    return { searches: searches?.length ?? 0, found, inserted };
  }

  private async assertOwner(id: string, vendedorLogin: string): Promise<SavedProspect> {
    const { data } = await this.supabase.from(PROSPECTS_TABLE).select('*').eq('id', id).maybeSingle();
    if (!data) throw new NotFoundException('Ese prospecto no existe.');
    if ((data.vendedor_login as string).toLowerCase() !== vendedorLogin.toLowerCase()) {
      throw new ForbiddenException('Ese prospecto es de otro vendedor.');
    }
    return this.toSaved(data as Record<string, unknown>);
  }

  private toSaved(r: Record<string, unknown>): SavedProspect {
    return {
      id: r.id as string,
      apolloId: r.apollo_id as string,
      estado: r.estado as SavedProspectEstado,
      origen: r.origen as SavedProspect['origen'],
      name: r.name as string,
      title: (r.title as string | null) ?? null,
      company: (r.company as string | null) ?? null,
      companyWebsite: (r.company_website as string | null) ?? null,
      industry: (r.industry as string | null) ?? null,
      location: (r.location as string | null) ?? null,
      linkedinUrl: (r.linkedin_url as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
      opportunityId: (r.opportunity_id as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  private toInteraction(r: Record<string, unknown>): ProspectInteraction {
    return {
      id: r.id as string,
      prospectId: r.prospect_id as string,
      tipo: r.tipo as ProspectInteractionTipo,
      resultado: r.resultado as ProspectInteractionResultado,
      notas: (r.notas as string | null) ?? null,
      referidoNombre: (r.referido_nombre as string | null) ?? null,
      referidoContacto: (r.referido_contacto as string | null) ?? null,
      reintentarAt: (r.reintentar_at as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  private toSearch(r: Record<string, unknown>): SavedProspectSearch {
    return {
      id: r.id as string,
      keywords: (r.keywords as string | null) ?? null,
      titles: (r.titles as string[]) ?? [],
      locations: (r.locations as string[]) ?? [],
      active: !!r.active,
      lastRunAt: (r.last_run_at as string | null) ?? null,
      createdAt: r.created_at as string,
      source: ((r.source as string) ?? 'apollo') as 'apollo' | 'web',
      city: (r.city as string | null) ?? null,
    };
  }

  private toProspect(p: ApolloPerson): SalesProspect | null {
    // api_search ofusca el apellido ("To***n"); match trae `name` completo.
    const name = p?.name || [p?.first_name, p?.last_name_obfuscated].filter(Boolean).join(' ');
    if (!p?.id || !name) return null;
    const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;
    // Apollo manda placeholders tipo "email_not_unlocked@domain.com" cuando el
    // email requiere crédito de enriquecimiento — eso no es un email real.
    const email = p.email && !p.email.includes('not_unlocked') ? p.email : null;
    return {
      id: p.id,
      name,
      title: p.title ?? null,
      company: p.organization?.name ?? null,
      companyWebsite: p.organization?.website_url ?? null,
      industry: p.organization?.industry ?? null,
      location,
      linkedinUrl: p.linkedin_url ?? null,
      email,
    };
  }

  // ── Envío de la propuesta al TL ───────────────────────────────────────────

  /** Registra que la propuesta se mandó al TL a revisar. Se repite si el
   *  cliente pide cambios, por eso es historial y no un campo. */
  async addTlReview(
    prospectId: string,
    vendedorLogin: string,
    input: { tlEmail: string; sentAt: string; comments?: string },
  ): Promise<ProspectTlReview> {
    await this.assertOwner(prospectId, vendedorLogin);

    const { data, error } = await this.supabase
      .from(TL_REVIEWS_TABLE)
      .insert({
        prospect_id: prospectId,
        vendedor_login: vendedorLogin,
        tl_email: input.tlEmail.trim().toLowerCase(),
        // La fecha viene como ISO del navegador; la columna es `date`.
        sent_at: input.sentAt.slice(0, 10),
        comments: input.comments?.trim() || null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(`No se pudo registrar el envío al TL: ${error.message}`);

    return this.toTlReview(data as Record<string, unknown>);
  }

  async listTlReviews(prospectId: string, vendedorLogin: string): Promise<ProspectTlReview[]> {
    await this.assertOwner(prospectId, vendedorLogin);
    const { data } = await this.supabase
      .from(TL_REVIEWS_TABLE)
      .select('*')
      .eq('prospect_id', prospectId)
      .order('sent_at', { ascending: false });
    return (data ?? []).map((r) => this.toTlReview(r as Record<string, unknown>));
  }

  private toTlReview(r: Record<string, unknown>): ProspectTlReview {
    return {
      id: r.id as string,
      tlEmail: r.tl_email as string,
      sentAt: r.sent_at as string,
      comments: (r.comments as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }
}
