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

  /** No necesita configuración: el dataset es público. */
  status(): { configured: boolean } {
    return { configured: true };
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

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      this.logger.error(`datos.gov.co no respondió: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Datos Abiertos Colombia no respondió. Intenta de nuevo.');
    }
    if (!res.ok) {
      const detalle = (await res.text().catch(() => '')).slice(0, 200);
      this.logger.error(`datos.gov.co ${res.status}: ${detalle}`);
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
