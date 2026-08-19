import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { normalizeDomain } from './scraper.utils';
import type { OpenDataCompany } from '../../../shared-types/sales.types';

/**
 * Descubrimiento de empresas desde DATOS ABIERTOS COLOMBIA (datos.gov.co),
 * dataset SECOP II — Proveedores Registrados (`qmzu-gj57`).
 *
 * Es mejor fuente que Google Custom Search para B2B colombiano, y por eso es
 * la fuente por defecto:
 *
 *   · GRATIS y SIN API KEY (Socrata abierto) — nada de cuotas de 100/día
 *   · 1.596.858 registros · 431.040 empresas activas · 59.577 en Bogotá
 *   · Trae NIT, teléfono, correo, dirección, municipio y sitio web ya
 *     estructurados — no hay que scrapear para tener con qué contactar
 *   · Es registro público oficial, no scraping de terceros
 *
 * Medido: `$q` (full-text indexado) responde en ~0,5s con todos los filtros.
 * OJO: `upper(nombre) LIKE '%...%'` NO está indexado y tarda >2 minutos —
 * inutilizable en serverless. Por eso siempre se busca con `$q`.
 *
 * Habeas Data (Ley 1581/2012): se excluyen las PERSONAS NATURALES, cuyos
 * datos son personales. Tampoco se traen los campos del representante legal
 * por el mismo motivo, aunque el dataset los exponga.
 */

const SODA_URL = 'https://www.datos.gov.co/resource/qmzu-gj57.json';
const TIMEOUT_MS = 20_000;
/** Socrata admite hasta 1000; de a 50 alcanza para una pantalla y mantiene
 *  la respuesta liviana. */
const MAX_LIMIT = 50;
/** Reintentos ante 503/429. Socrata devuelve 503 cuando el cupo ANÓNIMO de la
 *  IP está agotado, y las IPs de Vercel son compartidas entre miles de
 *  proyectos: desde una IP residencial la misma consulta responde 5/5 en 0,5s
 *  y desde el serverless rebota. El App Token lo resuelve de raíz; los
 *  reintentos son la red de contención mientras tanto. */
const REINTENTOS = 3;
const BACKOFF_MS = [400, 1200];

/**
 * Normaliza texto para poder buscar en el dataset, que tiene la codificación
 * CORROMPIDA EN ORIGEN. El mapa real de daño, medido sobre los municipios:
 *
 *   vocales con tilde  →  ROTAS, quedan en minúscula sin tilde
 *                         "BOGOTa", "MEDELLiN", "ALBaN", "AGUSTiN CODAZZI"
 *   Ñ                  →  INTACTA   "BRICEÑO", "CAÑASGORDAS"
 *   Ü                  →  INTACTA   "CHACHAGÜi"
 *
 * Por eso NO se pueden quitar todos los diacríticos: eso rompería Briceño y
 * Cañasgordas, que en el dataset sí están bien escritos. Se quitan solo las
 * tildes de vocales, que son las que están dañadas.
 *
 * Sin esto, escribir "Bogotá" con tilde devuelve CERO sobre 59.613 empresas.
 */
const TILDES_VOCAL: Record<string, string> = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U',
  à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u',
  À: 'A', È: 'E', Ì: 'I', Ò: 'O', Ù: 'U',
  â: 'a', ê: 'e', î: 'i', ô: 'o', û: 'u',
  Â: 'A', Ê: 'E', Î: 'I', Ô: 'O', Û: 'U',
  ä: 'a', ë: 'e', ï: 'i', ö: 'o',
  Ä: 'A', Ë: 'E', Ï: 'I', Ö: 'O',
};

/** Sufijos administrativos que el vendedor escribe y el dataset no tiene:
 *  "Bogotá D.C." está guardado como "BOGOTa" a secas. */
const SUFIJOS_ADMIN = /\s+(D\.?\s*C\.?|DC|DISTRITO\s+CAPITAL)\s*$/i;

/**
 * Deja el texto en la forma con la que sí se puede matchear:
 * sin tildes de vocal, sin puntuación, sin sufijos administrativos, con los
 * espacios colapsados. Tolera acentos, mayúsculas, espacios de más y comas.
 *
 *   "  Bogotá  D.C. " → "Bogota"
 *   "MEDELLÍN"        → "MEDELLIN"
 *   "Briceño"         → "Briceño"   (la ñ se conserva)
 */
export function normalizarBusqueda(texto: string): string {
  if (!texto) return '';
  let out = texto.normalize('NFC');
  out = out.replace(/[áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛäëïöÄËÏÖ]/g, (c) => TILDES_VOCAL[c] ?? c);
  out = out.replace(/[.,;:()"'`]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(SUFIJOS_ADMIN, '').trim();
  return out;
}

/** El dataset escribe "No Provisto" en vez de dejar el campo vacío. */
const SIN_DATO = /^(no provisto|no definido|n\/?a|ninguno|-)$/i;

// El tipo vive en shared-types (lo consume también el frontend).

function limpio(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || SIN_DATO.test(s)) return null;
  return s;
}

@Injectable()
export class OpenDataService {
  private readonly logger = new Logger(OpenDataService.name);

  /** Token de aplicación de Socrata. Es GRATIS y no autentica a nadie: solo
   *  identifica a la app para darle cupo propio en vez del pool anónimo
   *  compartido por IP. Sin él, desde Vercel se recibe 503 constante. */
  private get appToken(): string | null {
    return process.env.SOCRATA_APP_TOKEN?.trim().replace(/^["']|["']$/g, '') || null;
  }

  /** El dataset es público, así que siempre está "configurado" — pero avisamos
   *  si falta el token, que es lo que causa los 503 desde serverless. */
  status(): { configured: boolean; hasAppToken: boolean } {
    return { configured: true, hasAppToken: !!this.appToken };
  }

  /**
   * Busca empresas por palabra clave y ciudad.
   *
   * @param keywords texto libre — va por `$q`, el índice full-text de Socrata.
   * @param city     municipio; se compara en mayúsculas y por prefijo porque
   *                 el dataset trae "BOGOTa", "MEDELLiN" y variantes.
   */
  async search(keywords: string, city: string | null, limit = 25, offset = 0): Promise<OpenDataCompany[]> {
    // Mismo problema en los nombres: el dataset trae "LOGiSTICA" y "CONSTRUCCIoN".
    const q = normalizarBusqueda(keywords ?? '');
    if (!q) throw new BadRequestException('La búsqueda necesita al menos una palabra clave.');

    const where = [
      "esta_activa='Si'",
      // Habeas Data: una persona natural no es una empresa, y sus datos son personales.
      "tipo_empresa NOT LIKE '%PERSONA NATURAL%'",
      city ? `upper(municipio) LIKE '%${this.escape(normalizarBusqueda(city).toUpperCase())}%'` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const url = new URL(SODA_URL);
    url.searchParams.set('$q', q);
    url.searchParams.set('$where', where);
    url.searchParams.set('$limit', String(Math.min(limit, MAX_LIMIT)));
    url.searchParams.set('$offset', String(offset));

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.appToken) headers['X-App-Token'] = this.appToken;

    let res: Response | null = null;
    for (let intento = 0; intento < REINTENTOS; intento++) {
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        this.logger.warn(`datos.gov.co no respondió (intento ${intento + 1}): ${(err as Error).message}`);
        res = null;
      }
      // 503/429 = cupo de la IP agotado. Reintentar con espera suele bastar.
      if (res && res.status !== 503 && res.status !== 429) break;
      if (intento < REINTENTOS - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[intento] ?? 1200));
      }
    }

    if (!res) {
      throw new ServiceUnavailableException('Datos Abiertos Colombia no respondió. Intenta de nuevo.');
    }
    if (!res.ok) {
      const detalle = (await res.text().catch(() => '')).slice(0, 200);
      this.logger.error(`datos.gov.co ${res.status}: ${detalle}`);
      if (res.status === 503 || res.status === 429) {
        throw new ServiceUnavailableException(
          this.appToken
            ? 'Datos Abiertos está saturado en este momento. Intenta de nuevo en unos segundos.'
            : 'Datos Abiertos rechazó la consulta por exceso de peticiones. Falta configurar SOCRATA_APP_TOKEN en el backend (es gratis y da cupo propio).',
        );
      }
      throw new BadRequestException(`Datos Abiertos rechazó la consulta (${res.status}).`);
    }

    const filas = (await res.json().catch(() => [])) as Record<string, unknown>[];
    return Array.isArray(filas) ? filas.map((f) => this.toCompany(f)).filter((c) => !!c.name) : [];
  }

  private toCompany(f: Record<string, unknown>): OpenDataCompany {
    const web = limpio(f.sitio_web);
    return {
      name: limpio(f.nombre) ?? '',
      nit: limpio(f.nit),
      phone: limpio(f.telefono),
      email: limpio(f.correo)?.toLowerCase() ?? null,
      address: limpio(f.direccion),
      city: limpio(f.municipio),
      department: limpio(f.departamento),
      domain: web ? normalizeDomain(web) : null,
      companyType: limpio(f.tipo_empresa),
      category: limpio(f.descripcion_categoria_principal),
    };
  }

  /** Socrata usa comillas simples en SoQL; escaparlas evita romper el `$where`
   *  con nombres como "O'BRIEN". No es SQL contra nuestra base, pero igual no
   *  se concatena texto crudo del usuario. */
  private escape(s: string): string {
    return s.replace(/'/g, "''").replace(/[%_\\]/g, '');
  }
}
