/**
 * Utilidades puras del scraper de prospección web. Sin I/O ni dependencias:
 * todo lo de acá es testeable con `node --test` y es donde estas soluciones
 * se rompen en silencio (un dominio mal normalizado duplica filas, un regex
 * de teléfono flojo guarda basura que el vendedor descubre al llamar).
 */

/** Sufijos públicos de segundo nivel que usamos en Colombia. Con estos,
 *  "casaluker.com.co" registra en 3 etiquetas, no en 2. No metemos la PSL
 *  completa (2M de líneas) por un puñado de casos reales. */
const SECOND_LEVEL_SUFFIXES = new Set([
  'com.co', 'net.co', 'org.co', 'edu.co', 'gov.co', 'mil.co', 'nom.co',
  'com.ar', 'com.br', 'com.mx', 'com.pe', 'com.ec', 'com.ve',
  'co.uk', 'com.es',
]);

/**
 * Normaliza cualquier URL o host al dominio registrable (eTLD+1), en
 * minúsculas y sin `www.`. Es la llave de idempotencia: dos formas de escribir
 * el mismo sitio tienen que colapsar a la misma fila.
 *
 *   https://WWW.CasaLuker.com.co/contacto  →  casaluker.com.co
 *   http://tienda.exito.com/a?b=c          →  exito.com
 *
 * Devuelve null si no es un host usable (IP, localhost, basura).
 */
export function normalizeDomain(input: string): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();

  // Aceptamos tanto "https://x/y" como "x/y" como "x".
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = `http://${host}`;
  try {
    host = new URL(host).hostname;
  } catch {
    return null;
  }

  if (!host || host === 'localhost') return null;
  // IPv4/IPv6 no son empresas.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;

  host = host.replace(/^www\./, '').replace(/\.$/, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.some((l) => !/^[a-z0-9-]+$/.test(l))) return null;

  const lastTwo = labels.slice(-2).join('.');
  const take = SECOND_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return null;
  return labels.slice(-take).join('.');
}

/** Correos de rol (no personales). Habeas Data: guardamos buzones de la
 *  empresa, no direcciones de personas identificadas. */
const ROLE_MAILBOXES = /^(info|contacto|contactenos|ventas|comercial|hola|soporte|servicioalcliente|atencionalcliente|mercadeo|administracion|gerencia|rrhh|talento|pqr|notificaciones|facturacion)$/;

/** Extensiones que el regex de email confunde con dominios (logo@2x.png). */
const NOT_EMAIL_TLD = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf)$/i;

/**
 * Correos públicos del HTML. Devuelve SOLO buzones de rol: un
 * `nombre.apellido@empresa.com` es dato personal y no lo persistimos.
 */
export function extractRoleEmails(text: string): string[] {
  const found = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const raw of found) {
    const email = raw.toLowerCase();
    if (NOT_EMAIL_TLD.test(email)) continue;
    const local = email.split('@')[0];
    if (!ROLE_MAILBOXES.test(local)) continue;
    out.add(email);
  }
  return [...out];
}

/**
 * Teléfonos colombianos. Dos formas válidas desde la marcación unificada de
 * 2022, ambas de 10 dígitos:
 *   - móvil:  3XX XXX XXXX  (indicativos realmente asignados, no cualquier 3XX)
 *   - fijo:   60X XXX XXXX  (601 Bogotá, 604 Medellín, 602 Cali…)
 * Acepta +57 opcional, espacios, guiones y paréntesis. Normaliza a "+57XXXXXXXXXX".
 *
 * El HTML real está lleno de UUIDs y hashes que contienen secuencias de 10
 * dígitos: `...adfa-c23805172508` y `...b014a3030723815a8a` se colaban como
 * teléfonos. De ahí las dos defensas:
 *   1. el número no puede estar pegado a otro carácter alfanumérico, y
 *   2. el indicativo tiene que ser uno de los rangos asignados en Colombia.
 */
const PHONE_PREFIX = '3(?:0[0-5]|1\\d|2[0-4]|5[0-2])|60[1-8]';
const PHONE_RE = new RegExp(
  `(?<![0-9a-zA-Z])(?:\\+?57[\\s.-]*)?(?:\\(\\s*(${PHONE_PREFIX})\\s*\\)|(${PHONE_PREFIX}))[\\s.-]*(\\d{3})[\\s.-]*(\\d{4})(?![0-9a-zA-Z])`,
  'g',
);

export function extractColombianPhones(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) {
    const area = m[1] ?? m[2];
    out.add(`+57${area}${m[3]}${m[4]}`);
  }
  return [...out];
}

const SOCIAL_HOSTS: Record<string, string> = {
  'linkedin.com': 'linkedin',
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'x.com': 'x',
  'twitter.com': 'x',
  'youtube.com': 'youtube',
  'tiktok.com': 'tiktok',
};

/** Perfiles sociales del sitio, deduplicados por red (el primero que aparece). */
export function extractSocialLinks(hrefs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const href of hrefs) {
    const domain = normalizeDomain(href);
    if (!domain) continue;
    const red = SOCIAL_HOSTS[domain];
    // Descartamos el link "compartir en…" y la home de la red sin perfil.
    if (!red || out[red]) continue;
    try {
      const url = new URL(/^https?:\/\//.test(href) ? href : `https://${href}`);
      if (url.pathname.replace(/\/+$/, '') === '') continue;
      out[red] = url.toString();
    } catch {
      /* href inválido — se ignora */
    }
  }
  return out;
}

/**
 * Rutas candidatas donde suele estar el contacto en sitios colombianos.
 * Se prueban en orden y se corta en la primera que responda: cada fetch
 * cuesta tiempo del presupuesto de 60s de la función serverless.
 */
export const CONTACT_PATHS = [
  '/',
  '/contacto',
  '/contactenos',
  '/contacto-us',
  '/nosotros',
  '/quienes-somos',
  '/empresa',
] as const;
