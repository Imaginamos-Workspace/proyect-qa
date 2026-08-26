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
/** Las ciudades por país se cachean: agregarlas para Colombia tarda ~4,2s y
 *  el dataset cambia con muy baja frecuencia. */
const CIUDADES_TTL_MS = 6 * 60 * 60_000;
const MAX_CIUDADES = 100;

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

/**
 * País → código ISO-2, que es como el dataset guarda `pais` ("CO", "US", "ES").
 * Acepta el nombre en español, en inglés o el código directo, porque el
 * vendedor escribe "México", "Mexico" o "MX" indistintamente.
 *
 * OJO con la cobertura real, medida sobre el dataset: 1.597.779 empresas
 * colombianas contra 2.885 repartidas en 90 países. Fuera de Colombia esto
 * NO es un directorio internacional: son proveedores extranjeros inscritos
 * ante el Estado colombiano. El frontend lo advierte al elegir otro país.
 */
const PAISES: Record<string, string> = {
  colombia: 'CO',
  'estados unidos': 'US', 'united states': 'US', usa: 'US', eeuu: 'US',
  espana: 'ES', 'españa': 'ES', spain: 'ES',
  mexico: 'MX', 'méxico': 'MX',
  chile: 'CL',
  venezuela: 'VE',
  peru: 'PE', 'perú': 'PE',
  'reino unido': 'GB', 'united kingdom': 'GB', inglaterra: 'GB',
  brasil: 'BR', brazil: 'BR',
  argentina: 'AR',
  francia: 'FR', france: 'FR',
  panama: 'PA', 'panamá': 'PA',
  ecuador: 'EC',
  canada: 'CA', 'canadá': 'CA',
  alemania: 'DE', germany: 'DE',
  china: 'CN',
  italia: 'IT', italy: 'IT',
  portugal: 'PT',
  cuba: 'CU',
  suiza: 'CH', switzerland: 'CH',
  uruguay: 'UY',
  'paises bajos': 'NL', 'países bajos': 'NL', holanda: 'NL', netherlands: 'NL',
  'costa rica': 'CR',
  israel: 'IL',
  suecia: 'SE', sweden: 'SE',
  'republica checa': 'CZ', 'república checa': 'CZ',
  india: 'IN',
  japon: 'JP', 'japón': 'JP', japan: 'JP',
  'republica dominicana': 'DO', 'república dominicana': 'DO',
  guatemala: 'GT',
  bolivia: 'BO',
  paraguay: 'PY',
};

/** Devuelve el ISO-2 del país, o null si no se reconoce. Un código de 2 letras
 *  se acepta tal cual: así funcionan también los 60 países que no están en el
 *  mapa de nombres. */
export function codigoPais(entrada: string | null): string | null {
  const t = normalizarBusqueda(entrada ?? '').toLowerCase();
  if (!t) return null;
  if (/^[a-z]{2}$/.test(t)) return t.toUpperCase();
  return PAISES[t] ?? null;
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

  /**
   * Ciudades de un país, con cuántas empresas tiene cada una.
   *
   * Se cachea en memoria: agregarlas para Colombia tarda ~4,2s (500+
   * municipios) y el dataset cambia con muy baja frecuencia. Sin caché, cada
   * vez que el vendedor cambia de país esperaría ese tiempo.
   *
   * `No Provisto` se descarta: es el valor MÁS común del campo (105.554 en
   * Colombia, 577 de 626 en Estados Unidos) y no es una ciudad.
   */
  private ciudadesCache = new Map<string, { ts: number; datos: { city: string; count: number }[] }>();

  async cities(country: string | null): Promise<{ city: string; count: number }[]> {
    const pais = codigoPais(country);
    if (!pais) return [];

    const cacheado = this.ciudadesCache.get(pais);
    if (cacheado && Date.now() - cacheado.ts < CIUDADES_TTL_MS) return cacheado.datos;

    const url = new URL(SODA_URL);
    url.searchParams.set('$select', 'municipio,count(*) as n');
    url.searchParams.set(
      '$where',
      `esta_activa='Si' AND tipo_empresa NOT LIKE '%PERSONA NATURAL%' AND pais='${this.escape(pais)}'`,
    );
    url.searchParams.set('$group', 'municipio');
    url.searchParams.set('$order', 'n DESC');
    // Tope: con 100 se cubre lo que un vendedor puede llegar a usar, y evita
    // arrastrar los cientos de municipios con 1 sola empresa.
    url.searchParams.set('$limit', String(MAX_CIUDADES));

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.appToken) headers['X-App-Token'] = this.appToken;

    let filas: { municipio?: string; n?: string }[] = [];
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) filas = (await res.json().catch(() => [])) as typeof filas;
    } catch (err) {
      this.logger.warn(`No se pudieron listar ciudades de ${pais}: ${(err as Error).message}`);
      return cacheado?.datos ?? [];
    }

    const datos = filas
      .map((f) => ({ city: limpio(f.municipio) ?? '', count: Number(f.n ?? 0) }))
      .filter((c) => !!c.city)
      .sort((a, b) => b.count - a.count);

    this.ciudadesCache.set(pais, { ts: Date.now(), datos });
    return datos;
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
  async search(
    keywords: string,
    city: string | null,
    country: string | null = 'Colombia',
    limit = 25,
    offset = 0,
  ): Promise<{ companies: OpenDataCompany[]; hasMore: boolean }> {
    // La palabra clave es OPCIONAL: sin ella se listan todas las empresas del
    // país (paginadas), que es como el vendedor explora un mercado nuevo antes
    // de saber qué buscar. Con ella se filtra por razón social.
    // Mismo problema de codificación en los nombres: "LOGiSTICA", "CONSTRUCCIoN".
    const q = normalizarBusqueda(keywords ?? '');
    const pais = codigoPais(country);
    // Si el vendedor escribió un país y no lo reconocemos, fallar es lo correcto:
    // ignorarlo devolvía empresas colombianas haciéndolas pasar por extranjeras.
    if (country?.trim() && !pais) {
      throw new BadRequestException(
        `No reconozco el país "${country.trim()}". Escribilo completo (Colombia, México, España…) o usa su código de 2 letras (CO, MX, ES).`,
      );
    }

    const where = [
      "esta_activa='Si'",
      // Habeas Data: una persona natural no es una empresa, y sus datos son personales.
      "tipo_empresa NOT LIKE '%PERSONA NATURAL%'",
      // `tipo_empresa` sola no alcanza: 224.749 registros dicen 'OTRO' y ahí se
      // mezclan personas con empresas reales. La señal que sí las separa es que
      // una persona natural se inscribe con SU PROPIO nombre, así que la razón
      // social coincide exacta con la del representante legal; una empresa no.
      // Medido sobre Bogotá: 59.741 filas → 36.309, y las 23.432 descartadas
      // eran personas. Una empresa nombrada por su fundador ("PEREZ E HIJOS SAS")
      // no coincide exacta, así que sobrevive al filtro.
      'upper(nombre) != upper(nombre_representante_legal)',
      city ? `upper(municipio) LIKE '%${this.escape(normalizarBusqueda(city).toUpperCase())}%'` : null,
      pais ? `pais='${this.escape(pais)}'` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const porPagina = Math.min(limit, MAX_LIMIT);
    const url = new URL(SODA_URL);
    if (q) url.searchParams.set('$q', q);
    url.searchParams.set('$where', where);
    // Se pide UNO de más para saber si hay página siguiente sin gastar una
    // consulta de conteo aparte (contar sobre 1,6M de filas es caro).
    url.searchParams.set('$limit', String(porPagina + 1));
    url.searchParams.set('$offset', String(offset));
    // Sin `$order` a propósito. Ordenar por `nombre` es inviable en paginación
    // profunda: la columna no está indexada y Socrata se cuelga (>120s a partir
    // de offset 3000, contra 21s sin orden en offset 30000). El orden natural
    // del dataset resultó estable —misma consulta devuelve las mismas filas, y
    // páginas contiguas no se solapan—, que es lo que la paginación necesita.

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
    if (!Array.isArray(filas)) return { companies: [], hasMore: false };
    const hasMore = filas.length > porPagina;
    const companies = filas.slice(0, porPagina).map((f) => this.toCompany(f)).filter((c) => !!c.name);
    return { companies, hasMore };
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
