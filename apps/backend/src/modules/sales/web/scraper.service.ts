import { Injectable, Logger } from '@nestjs/common';
import { parse } from 'node-html-parser';
import {
  CONTACT_PATHS,
  extractColombianPhones,
  extractRoleEmails,
  extractSocialLinks,
  normalizeDomain,
} from './scraper.utils';

/** Lo que se logra extraer de un sitio. Todo opcional: la mayoría de los
 *  sitios no publica todo, y media ficha sirve más que ninguna. */
export interface ScrapedCompany {
  domain: string;
  /** <title> limpio — suele ser la razón social o el nombre comercial. */
  name: string | null;
  /** <meta name="description"> */
  description: string | null;
  emails: string[];
  phones: string[];
  socialLinks: Record<string, string>;
  /** URL concreta de la que salieron los datos (trazabilidad Habeas Data). */
  sourceUrl: string;
}

/** Identificable y con forma de contactarnos: es lo que distingue a un bot
 *  correcto de uno abusivo, y lo que permite que un sitio nos bloquee a
 *  nosotros sin bloquear a todo el mundo. */
const USER_AGENT =
  'ImaginamosQABot/1.0 (+https://qa-frontend-lime.vercel.app; prospeccion B2B; contacto: viviana.gutierrez@imaginamos.com)';

/** Timeout por request. Corto a propósito: el presupuesto total de la función
 *  serverless es de 60s y hay que repartirlo entre varios sitios. */
const FETCH_TIMEOUT_MS = 5_000;
/** Techo de bytes por página — evita que un sitio con un HTML gigante se
 *  coma el presupuesto de memoria y de tiempo. */
const MAX_HTML_BYTES = 1_500_000;

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  /** Cache de robots.txt por dominio dentro de la misma invocación. */
  private readonly robotsCache = new Map<string, string[]>();

  /**
   * Extrae la ficha pública de un dominio. Devuelve null si robots.txt lo
   * prohíbe o si el sitio no respondió nada útil.
   *
   * @param deadlineMs marca de tiempo (Date.now()) a partir de la cual hay que
   *        rendirse. El llamador reparte el presupuesto de 60s entre dominios.
   */
  async scrapeDomain(rawDomain: string, deadlineMs = Date.now() + 20_000): Promise<ScrapedCompany | null> {
    const domain = normalizeDomain(rawDomain);
    if (!domain) return null;

    const disallow = await this.loadRobots(domain);

    const acc: ScrapedCompany = {
      domain,
      name: null,
      description: null,
      emails: [],
      phones: [],
      socialLinks: {},
      sourceUrl: `https://${domain}/`,
    };

    for (const path of CONTACT_PATHS) {
      if (Date.now() > deadlineMs) break;
      if (this.isDisallowed(disallow, path)) continue;

      const url = `https://${domain}${path}`;
      const html = await this.fetchHtml(url);
      if (!html) continue;

      this.merge(acc, html, url);

      // Con nombre + (correo o teléfono) ya alcanza para que el vendedor
      // trabaje el lead. Seguir pidiendo páginas es gastar presupuesto.
      if (acc.name && (acc.emails.length || acc.phones.length)) break;
    }

    const vacio = !acc.name && !acc.emails.length && !acc.phones.length;
    return vacio ? null : acc;
  }

  /** Vuelca lo que encuentre en el HTML sobre el acumulador, sin pisar lo ya
   *  hallado: la home suele tener el mejor <title>, y /contacto los datos. */
  private merge(acc: ScrapedCompany, html: string, url: string): void {
    const root = parse(html);

    if (!acc.name) {
      const title = root.querySelector('title')?.text?.trim();
      // "Inicio | Empresa S.A.S" → nos quedamos con la parte más informativa.
      if (title) acc.name = title.split(/\s*[|·—–]\s*/).sort((a, b) => b.length - a.length)[0]?.slice(0, 200) ?? null;
    }
    if (!acc.description) {
      const desc = root.querySelector('meta[name="description"]')?.getAttribute('content');
      if (desc) acc.description = desc.trim().slice(0, 500);
    }

    // `mailto:` y `tel:` son señal mucho más limpia que el texto suelto.
    const hrefs = root.querySelectorAll('a[href]').map((a) => a.getAttribute('href') ?? '');
    const texto = [root.text, ...hrefs].join('\n');

    for (const email of extractRoleEmails(texto)) {
      if (!acc.emails.includes(email)) acc.emails.push(email);
    }
    for (const phone of extractColombianPhones(texto)) {
      if (!acc.phones.includes(phone)) acc.phones.push(phone);
    }
    acc.socialLinks = { ...extractSocialLinks(hrefs), ...acc.socialLinks };

    if (acc.sourceUrl === `https://${acc.domain}/` && url !== acc.sourceUrl) acc.sourceUrl = url;
  }

  /** GET con timeout, límite de tamaño y sin seguir a otro dominio. */
  private async fetchHtml(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      if (!(res.headers.get('content-type') ?? '').includes('html')) return null;

      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_HTML_BYTES) return null;

      const html = await res.text();
      return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
    } catch {
      // Timeout, DNS, TLS, 4xx/5xx: el sitio no coopera y no es un error nuestro.
      return null;
    }
  }

  /** Reglas Disallow que aplican a nuestro user-agent (o a `*`). Ante la duda
   *  —robots.txt ilegible o caído— asumimos permitido, que es el default de
   *  la norma, pero registramos el caso. */
  private async loadRobots(domain: string): Promise<string[]> {
    const cached = this.robotsCache.get(domain);
    if (cached) return cached;

    let reglas: string[] = [];
    try {
      const res = await fetch(`https://${domain}/robots.txt`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) reglas = this.parseRobots(await res.text());
    } catch {
      this.logger.debug(`robots.txt inaccesible en ${domain} — se asume permitido`);
    }
    this.robotsCache.set(domain, reglas);
    return reglas;
  }

  /** Parser mínimo: junta los Disallow de los bloques que nos aplican. */
  private parseRobots(txt: string): string[] {
    const out: string[] = [];
    let aplica = false;
    for (const linea of txt.split('\n')) {
      const l = linea.split('#')[0].trim();
      const [campoRaw, ...resto] = l.split(':');
      const campo = campoRaw.trim().toLowerCase();
      const valor = resto.join(':').trim();
      if (campo === 'user-agent') {
        aplica = valor === '*' || USER_AGENT.toLowerCase().startsWith(valor.toLowerCase().split('/')[0]);
      } else if (campo === 'disallow' && aplica && valor) {
        out.push(valor);
      }
    }
    return out;
  }

  private isDisallowed(reglas: string[], path: string): boolean {
    return reglas.some((r) => (r === '/' ? true : path.startsWith(r)));
  }
}
