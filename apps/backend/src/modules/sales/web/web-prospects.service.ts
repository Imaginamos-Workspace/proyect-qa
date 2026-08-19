import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../config/supabase.module';
import { ScraperService } from './scraper.service';
import { normalizeDomain } from './scraper.utils';
import type { OpenDataCompany } from '../../../shared-types/sales.types';

const PROSPECTS_TABLE = 'sales_prospects';
const SEARCHES_TABLE = 'sales_prospect_searches';
const BLOCKLIST_TABLE = 'sales_domain_blocklist';

const CSE_URL = 'https://www.googleapis.com/customsearch/v1';
const CSE_TIMEOUT_MS = 15_000;
/** Google devuelve 10 por request y cada request cuenta contra la cuota
 *  (100/día gratis). Tope duro por búsqueda guardada para que una corrida no
 *  se coma el día entero. */
const MAX_PAGES_POR_BUSQUEDA = 3;

/** La función serverless tiene 60s (ver apps/backend/vercel.json). Se reserva
 *  margen para el resto del handler: nunca arrancamos un scrape nuevo pasado
 *  este presupuesto. */
const PRESUPUESTO_SCRAPE_MS = 45_000;
/** Techo de dominios por corrida — con ~2s por sitio entran de sobra en el
 *  presupuesto, y deja margen para los lentos. */
const LOTE_SCRAPE = 15;

interface CseItem {
  title?: string;
  link?: string;
  snippet?: string;
}

@Injectable()
export class WebProspectsService {
  private readonly logger = new Logger(WebProspectsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly scraper: ScraperService,
  ) {}

  private get cseKey(): string | null {
    // Mismo saneo que APOLLO_API_KEY: Vercel guarda comillas si se pega entrecomillada.
    return process.env.GOOGLE_CSE_KEY?.trim().replace(/^["']|["']$/g, '') || null;
  }
  private get cseCx(): string | null {
    return process.env.GOOGLE_CSE_CX?.trim().replace(/^["']|["']$/g, '') || null;
  }

  /** El frontend lo usa para mostrar la guía de configuración en vez del buscador. */
  status(): { configured: boolean } {
    return { configured: !!this.cseKey && !!this.cseCx };
  }

  // ── Descubrimiento ────────────────────────────────────────────────────────

  /**
   * Busca en Google y devuelve los DOMINIOS candidatos, ya normalizados,
   * deduplicados y sin los de la blocklist. No toca la base: separar el
   * descubrimiento de la persistencia hace que se pueda probar solo.
   */
  async discover(keywords: string, city: string | null, paginas = 1): Promise<{ domain: string; title: string }[]> {
    const key = this.cseKey;
    const cx = this.cseCx;
    if (!key || !cx) {
      throw new BadRequestException('Faltan GOOGLE_CSE_KEY y/o GOOGLE_CSE_CX en el backend.');
    }

    const q = [keywords, city].filter(Boolean).join(' ').trim();
    if (!q) throw new BadRequestException('La búsqueda necesita al menos palabras clave o ciudad.');

    const bloqueados = await this.loadBlocklist();
    const porDominio = new Map<string, string>();

    for (let p = 0; p < Math.min(paginas, MAX_PAGES_POR_BUSQUEDA); p++) {
      const url = new URL(CSE_URL);
      url.searchParams.set('key', key);
      url.searchParams.set('cx', cx);
      url.searchParams.set('q', q);
      url.searchParams.set('num', '10');
      url.searchParams.set('start', String(p * 10 + 1));
      url.searchParams.set('gl', 'co'); // sesga a Colombia
      url.searchParams.set('hl', 'es');

      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(CSE_TIMEOUT_MS) });
      } catch (err) {
        this.logger.error(`Google CSE no respondió: ${(err as Error).message}`);
        throw new ServiceUnavailableException('Google no respondió la búsqueda. Intenta de nuevo.');
      }
      if (!res.ok) {
        const detalle = (await res.text().catch(() => '')).slice(0, 250);
        this.logger.error(`Google CSE ${res.status}: ${detalle}`);
        // 429 = cuota diaria agotada; es lo más común y conviene decirlo claro.
        throw new BadRequestException(
          res.status === 429
            ? 'Se agotó la cuota diaria de búsquedas de Google (100/día en el plan gratis).'
            : `Google rechazó la búsqueda (${res.status}). ${detalle}`,
        );
      }

      const data = (await res.json().catch(() => ({}))) as { items?: CseItem[] };
      const items = data.items ?? [];
      for (const it of items) {
        const domain = normalizeDomain(it.link ?? '');
        if (!domain || bloqueados.has(domain) || porDominio.has(domain)) continue;
        porDominio.set(domain, (it.title ?? domain).slice(0, 200));
      }
      // Menos de 10 = no hay más páginas; seguir sería gastar cuota al pedo.
      if (items.length < 10) break;
    }

    return [...porDominio].map(([domain, title]) => ({ domain, title }));
  }

  /**
   * Descubre y guarda como pendientes (`last_scraped_at = null`). No scrapea
   * acá: eso lo hace `scrapePending` en lotes, para no reventar el límite de
   * tiempo de la función.
   */
  async discoverAndQueue(
    vendedorLogin: string,
    keywords: string,
    city: string | null,
    paginas = 1,
  ): Promise<{ found: number; queued: number }> {
    const candidatos = await this.discover(keywords, city, paginas);
    let queued = 0;

    for (const c of candidatos) {
      const { error } = await this.supabase.from(PROSPECTS_TABLE).insert({
        // Mismo patrón que los referidos ('ref-<uuid>'): la fuente va en el prefijo.
        apollo_id: `web:${c.domain}`,
        vendedor_login: vendedorLogin,
        source: 'web',
        origen: 'manual',
        domain: c.domain,
        name: c.title,
        company: c.title,
        company_website: `https://${c.domain}`,
        // La tabla usa `location` (026), no `city` — `city` solo existe en los filtros.
        location: city,
        last_scraped_at: null,
      });
      // 23505 = ya existía para este vendedor → idempotente, no es error.
      if (!error) queued++;
      else if (error.code !== '23505') {
        this.logger.warn(`No se pudo encolar ${c.domain}: ${error.message}`);
      }
    }
    return { found: candidatos.length, queued };
  }

  /**
   * Guarda en el pipeline una empresa venida de Datos Abiertos.
   *
   * La llave de idempotencia es el NIT (`nit:<nit>`), no el dominio: es el
   * identificador oficial de la empresa en Colombia y muchas no declaran
   * sitio web. Si no hay NIT se cae al dominio, y si tampoco hay, se rechaza
   * — sin una llave estable el mismo lead entraría duplicado en cada corrida.
   *
   * Reutiliza el mismo patrón de prefijo que los referidos ('ref-<uuid>') y
   * los de Google ('web:<dominio>').
   */
  async saveFromOpenData(vendedorLogin: string, c: OpenDataCompany): Promise<{ saved: boolean; reason?: string }> {
    const key = c.nit ? `nit:${c.nit}` : c.domain ? `web:${c.domain}` : null;
    if (!key) return { saved: false, reason: 'La empresa no trae NIT ni sitio web — sin llave estable no se puede guardar.' };

    const { error } = await this.supabase.from(PROSPECTS_TABLE).insert({
      apollo_id: key,
      vendedor_login: vendedorLogin,
      source: 'web',
      origen: 'manual',
      domain: c.domain,
      // El registro da la EMPRESA, no una persona: `name` queda con la razón
      // social y el vendedor completa el contacto cuando lo consiga.
      name: c.name,
      company: c.name,
      company_website: c.domain ? `https://${c.domain}` : null,
      industry: c.category,
      location: [c.city, c.department].filter(Boolean).join(', ') || null,
      email: c.email,
      phone: c.phone,
      notes: c.nit ? `NIT ${c.nit}${c.companyType ? ` · ${c.companyType}` : ''}${c.address ? ` · ${c.address}` : ''}` : null,
      source_url: 'https://www.datos.gov.co/resource/qmzu-gj57.json',
      // Si declaró sitio web queda pendiente de scrapear para sumarle correo
      // y redes; si no, no hay nada que scrapear y se marca como ya visto.
      last_scraped_at: c.domain ? null : new Date().toISOString(),
    });

    if (error) {
      if (error.code === '23505') return { saved: false, reason: 'Ya estaba en el pipeline.' };
      this.logger.warn(`No se pudo guardar ${key}: ${error.message}`);
      return { saved: false, reason: error.message };
    }
    return { saved: true };
  }

  // ── Scraping en lotes ─────────────────────────────────────────────────────

  /**
   * Toma los pendientes más viejos y los enriquece con el scraper. Acotado por
   * tiempo Y por cantidad: lo que no entra queda para la próxima corrida, que
   * es justamente para lo que sirve `last_scraped_at`.
   */
  async scrapePending(limit = LOTE_SCRAPE): Promise<{ procesados: number; conDatos: number }> {
    const finAntesDe = Date.now() + PRESUPUESTO_SCRAPE_MS;

    const { data: pendientes, error } = await this.supabase
      .from(PROSPECTS_TABLE)
      .select('id, domain')
      .eq('source', 'web')
      .is('last_scraped_at', null)
      .limit(limit);
    if (error || !pendientes?.length) return { procesados: 0, conDatos: 0 };

    let procesados = 0;
    let conDatos = 0;

    for (const fila of pendientes) {
      if (Date.now() > finAntesDe) {
        this.logger.log(`Presupuesto agotado — quedan ${pendientes.length - procesados} para la próxima corrida.`);
        break;
      }
      const domain = fila.domain as string;
      if (!domain) continue;

      const ficha = await this.scraper.scrapeDomain(domain, finAntesDe).catch(() => null);
      procesados++;

      // Siempre se marca la fecha, haya datos o no: si no, el dominio muerto
      // se reintentaría en cada corrida y bloquearía la cola para siempre.
      const patch: Record<string, unknown> = { last_scraped_at: new Date().toISOString() };
      if (ficha) {
        conDatos++;
        if (ficha.name) patch.company = ficha.name;
        if (ficha.name) patch.name = ficha.name;
        if (ficha.emails[0]) patch.email = ficha.emails[0];
        if (ficha.phones[0]) patch.phone = ficha.phones[0];
        if (ficha.socialLinks.linkedin) patch.linkedin_url = ficha.socialLinks.linkedin;
        patch.source_url = ficha.sourceUrl;
      }

      await this.supabase.from(PROSPECTS_TABLE).update(patch).eq('id', fila.id as string);
    }

    return { procesados, conDatos };
  }

  /** Corrida semanal de la fuente web: descubre con cada filtro activo y
   *  después scrapea lo que entre en el presupuesto. */
  async runWeekly(): Promise<{ searches: number; found: number; queued: number; scraped: number }> {
    const { data: searches } = await this.supabase
      .from(SEARCHES_TABLE)
      .select('*')
      .eq('active', true)
      .eq('source', 'web');

    let found = 0;
    let queued = 0;
    for (const s of searches ?? []) {
      const r = await this.discoverAndQueue(
        s.vendedor_login as string,
        (s.keywords as string) ?? '',
        (s.city as string) ?? null,
        1,
      ).catch((e) => {
        this.logger.warn(`Filtro ${s.id} falló: ${(e as Error).message}`);
        return null;
      });
      if (!r) continue;
      found += r.found;
      queued += r.queued;
      await this.supabase
        .from(SEARCHES_TABLE)
        .update({ last_run_at: new Date().toISOString() })
        .eq('id', s.id as string);
    }

    const { procesados } = await this.scrapePending();
    return { searches: searches?.length ?? 0, found, queued, scraped: procesados };
  }

  private async loadBlocklist(): Promise<Set<string>> {
    const { data } = await this.supabase.from(BLOCKLIST_TABLE).select('domain');
    return new Set((data ?? []).map((r) => r.domain as string));
  }
}
