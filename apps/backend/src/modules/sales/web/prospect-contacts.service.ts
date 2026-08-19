import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { SUPABASE_CLIENT } from '../../../config/supabase.module';
import { normalizeDomain } from './scraper.utils';

const PROSPECTS_TABLE = 'sales_prospects';
const CONTACTS_TABLE = 'sales_prospect_contacts';

const APOLLO_PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const APOLLO_MATCH = 'https://api.apollo.io/api/v1/people/match';
const TIMEOUT_MS = 15_000;

/**
 * Cargos que le interesan al vendedor, por segmento. En una startup manda
 * cualquiera; en una empresa grande hay que apuntar al decisor correcto.
 */
export const TITLES_POR_SEGMENTO: Record<string, string[]> = {
  Startup: [], // sin filtro: equipos chicos, cualquier contacto sirve
  SMB: [
    'CEO', 'Gerente General', 'Director General', 'COO', 'Operations Director',
    'Gerente de Operaciones', 'IT Manager', 'Gerente de Tecnologia',
    'Jefe de Recursos Humanos', 'Gerente Comercial', 'Manager',
  ],
  Enterprise: [
    'CIO', 'CTO', 'VP of Technology', 'Director de Transformacion Digital',
    'Director de Innovacion', 'Director de Recursos Humanos',
    'Director de Compras', 'Head of E-commerce', 'Manager',
  ],
};

/** Agrupa el título libre de Apollo en una etiqueta con la que sí se puede
 *  filtrar: cada empresa escribe el mismo cargo de diez formas distintas. */
export function roleTagFor(title: string | null | undefined): string {
  const t = (title ?? '').toLowerCase();
  if (/\b(ceo|chief executive|gerente general|director general|presidente)\b/.test(t)) return 'ceo';
  if (/\b(rrhh|recursos humanos|human resources|people|talento|hr)\b/.test(t)) return 'rrhh';
  if (/\b(cto|cio|tecnolog|technology|sistemas|it\b|software)\b/.test(t)) return 'tecnologia';
  if (/\b(compras|procurement|abastecimiento|purchasing)\b/.test(t)) return 'compras';
  if (/\b(comercial|ventas|sales|revenue|business development)\b/.test(t)) return 'comercial';
  if (/\b(cfo|financ|contab|tesorer)\b/.test(t)) return 'finanzas';
  if (/\b(coo|operac|operations|director|gerente|head|vp|chief)\b/.test(t)) return 'direccion';
  return 'otro';
}

export interface ProspectContact {
  id: string;
  name: string;
  title: string | null;
  roleTag: string;
  email: string | null;
  phone: string | null;
  /** Enlace de WhatsApp armado desde el teléfono — no cuesta nada y es el
   *  canal que más usa el vendedor en Colombia. */
  whatsapp: string | null;
  linkedinUrl: string | null;
  source: string;
}

export interface ContactsResult {
  contacts: ProspectContact[];
  /** true = salió de nuestra base, no se consumió nada de Apollo. */
  fromCache: boolean;
  status: 'ok' | 'sin-resultados' | 'plan-no-permite' | 'error' | 'sin-dominio';
  enrichedAt: string | null;
  message?: string;
}

@Injectable()
export class ProspectContactsService {
  private readonly logger = new Logger(ProspectContactsService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get apiKey(): string | null {
    return process.env.APOLLO_API_KEY?.trim().replace(/^["']|["']$/g, '') || null;
  }

  /**
   * Contactos de un prospecto. Este es el ÚNICO punto del flujo que puede
   * gastar créditos de Apollo, y solo la primera vez:
   *
   *   contacts_enriched_at con fecha  →  se lee de la base, 0 llamadas
   *   contacts_enriched_at en NULL    →  se consulta Apollo y se persiste
   *
   * Se marca la fecha aunque no se encuentre a nadie: ese "no hay contactos"
   * también costó, y repetirlo sería pagar dos veces por la misma respuesta.
   */
  async getContacts(prospectId: string, vendedorLogin: string, forzar = false): Promise<ContactsResult> {
    const { data: prospect } = await this.supabase
      .from(PROSPECTS_TABLE)
      .select('id, vendedor_login, domain, company_website, company, contacts_enriched_at, contacts_status')
      .eq('id', prospectId)
      .maybeSingle();

    if (!prospect) throw new NotFoundException('Ese prospecto no existe.');
    if ((prospect.vendedor_login as string)?.toLowerCase() !== vendedorLogin.toLowerCase()) {
      throw new ForbiddenException('Ese prospecto es de otro vendedor.');
    }

    const yaEnriquecido = !!prospect.contacts_enriched_at;
    if (yaEnriquecido && !forzar) {
      const contacts = await this.readContacts(prospectId);
      return {
        contacts,
        fromCache: true,
        status: (prospect.contacts_status as ContactsResult['status']) ?? 'ok',
        enrichedAt: prospect.contacts_enriched_at as string,
      };
    }

    // A partir de acá sí se consume Apollo.
    const domain =
      (prospect.domain as string | null) ??
      normalizeDomain((prospect.company_website as string) ?? '') ??
      null;

    if (!domain) {
      await this.marcar(prospectId, 'sin-dominio');
      return {
        contacts: [],
        fromCache: false,
        status: 'sin-dominio',
        enrichedAt: new Date().toISOString(),
        message: 'La empresa no tiene sitio web registrado, así que no hay por dónde buscar contactos. Cargalos a mano.',
      };
    }

    const r = await this.fetchFromApollo(domain);
    if (r.status === 'ok' && r.raw.length) {
      await this.persist(prospectId, r.raw);
    }
    await this.marcar(prospectId, r.status);

    return {
      contacts: r.status === 'ok' ? await this.readContacts(prospectId) : [],
      fromCache: false,
      status: r.status,
      enrichedAt: new Date().toISOString(),
      message: r.message,
    };
  }

  /** Alta manual — el vendedor consiguió el contacto llamando. No cuesta nada
   *  y es el camino que queda mientras el plan de Apollo no habilite personas. */
  async addManual(
    prospectId: string,
    vendedorLogin: string,
    input: { name: string; title?: string; email?: string; phone?: string; linkedinUrl?: string },
  ): Promise<ProspectContact> {
    const { data: prospect } = await this.supabase
      .from(PROSPECTS_TABLE)
      .select('id, vendedor_login')
      .eq('id', prospectId)
      .maybeSingle();
    if (!prospect) throw new NotFoundException('Ese prospecto no existe.');
    if ((prospect.vendedor_login as string)?.toLowerCase() !== vendedorLogin.toLowerCase()) {
      throw new ForbiddenException('Ese prospecto es de otro vendedor.');
    }

    const { data, error } = await this.supabase
      .from(CONTACTS_TABLE)
      .insert({
        prospect_id: prospectId,
        external_id: `manual-${randomUUID()}`,
        source: 'manual',
        name: input.name,
        title: input.title ?? null,
        role_tag: roleTagFor(input.title),
        email: input.email ?? null,
        phone: input.phone ?? null,
        linkedin_url: input.linkedinUrl ?? null,
      })
      .select('*')
      .single();
    if (error) throw new NotFoundException(`No se pudo guardar el contacto: ${error.message}`);
    return this.toContact(data as Record<string, unknown>);
  }

  // ── internos ──────────────────────────────────────────────────────────────

  private async readContacts(prospectId: string): Promise<ProspectContact[]> {
    const { data } = await this.supabase
      .from(CONTACTS_TABLE)
      .select('*')
      .eq('prospect_id', prospectId)
      .order('role_tag');
    return (data ?? []).map((r) => this.toContact(r as Record<string, unknown>));
  }

  private async marcar(prospectId: string, status: ContactsResult['status']): Promise<void> {
    await this.supabase
      .from(PROSPECTS_TABLE)
      .update({ contacts_enriched_at: new Date().toISOString(), contacts_status: status })
      .eq('id', prospectId);
  }

  private async persist(prospectId: string, personas: Record<string, unknown>[]): Promise<void> {
    const filas = personas.map((p) => ({
      prospect_id: prospectId,
      external_id: (p.id as string) ?? `apollo-${randomUUID()}`,
      source: 'apollo',
      name: (p.name as string) ?? 'Sin nombre',
      title: (p.title as string) ?? null,
      role_tag: roleTagFor(p.title as string),
      email: (p.email as string) ?? null,
      phone: (p.phone as string) ?? null,
      linkedin_url: (p.linkedin_url as string) ?? null,
      seniority: (p.seniority as string) ?? null,
    }));
    if (!filas.length) return;
    const { error } = await this.supabase
      .from(CONTACTS_TABLE)
      .upsert(filas, { onConflict: 'prospect_id,external_id' });
    if (error) this.logger.warn(`No se pudieron guardar los contactos: ${error.message}`);
  }

  /** Los dos endpoints de personas de Apollo. Hoy dan 403 en el plan Free —
   *  se distingue ese caso para poder decírselo al vendedor con claridad, y
   *  para NO reintentar (el 403 no cambia hasta que cambie el plan). */
  private async fetchFromApollo(
    domain: string,
  ): Promise<{ status: ContactsResult['status']; raw: Record<string, unknown>[]; message?: string }> {
    const key = this.apiKey;
    if (!key) return { status: 'error', raw: [], message: 'Falta APOLLO_API_KEY en el backend.' };

    try {
      const res = await fetch(APOLLO_PEOPLE_SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
        body: JSON.stringify({ q_organization_domains_list: [domain], per_page: 5, page: 1 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 403 || res.status === 401) {
        const detalle = (await res.text().catch(() => '')).slice(0, 200);
        this.logger.warn(`Apollo personas ${res.status} para ${domain}: ${detalle}`);
        return {
          status: 'plan-no-permite',
          raw: [],
          message:
            'Tu plan de Apollo no incluye la búsqueda de personas. Podés cargar el contacto a mano; el resto del prospecto ya está.',
        };
      }
      if (!res.ok) return { status: 'error', raw: [], message: `Apollo devolvió ${res.status}.` };

      const data = (await res.json().catch(() => ({}))) as { people?: Record<string, unknown>[] };
      const people = data.people ?? [];
      if (!people.length) return { status: 'sin-resultados', raw: [] };

      // people/match devuelve el dato completo (correo, teléfono) — 1 crédito
      // por persona, y solo acá, con el vendedor ya trabajando el prospecto.
      const completos: Record<string, unknown>[] = [];
      for (const p of people.slice(0, 3)) {
        if (!p.id) continue;
        const m = await fetch(APOLLO_MATCH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
          body: JSON.stringify({ id: p.id }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }).catch(() => null);
        if (!m?.ok) {
          completos.push(p); // nos quedamos con la vista previa
          continue;
        }
        const j = (await m.json().catch(() => ({}))) as { person?: Record<string, unknown> };
        completos.push(j.person ?? p);
      }
      return { status: 'ok', raw: completos };
    } catch (err) {
      this.logger.error(`Apollo personas falló: ${(err as Error).message}`);
      return { status: 'error', raw: [], message: 'Apollo no respondió.' };
    }
  }

  private toContact(r: Record<string, unknown>): ProspectContact {
    const phone = (r.phone as string | null) ?? null;
    return {
      id: r.id as string,
      name: r.name as string,
      title: (r.title as string | null) ?? null,
      roleTag: (r.role_tag as string) ?? 'otro',
      email: (r.email as string | null) ?? null,
      phone,
      whatsapp: phone ? `https://wa.me/${phone.replace(/[^\d]/g, '')}` : null,
      linkedinUrl: (r.linkedin_url as string | null) ?? null,
      source: (r.source as string) ?? 'apollo',
    };
  }
}
