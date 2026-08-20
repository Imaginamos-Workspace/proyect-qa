import { IsArray, IsIn, IsInt, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const SLUG = /^[a-z0-9-]+$/;

/** Crear una oportunidad nueva — mismo kebab-case que exige `sales:new` local. */
export class CreateOpportunityDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(SLUG, { message: 'cliente debe ser kebab-case (a-z0-9-).' })
  cliente: string;

  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(SLUG, { message: 'oportunidad debe ser kebab-case (a-z0-9-).' })
  oportunidad: string;
}

/** Mensaje del vendedor en el chat de la oportunidad. */
export class SendMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(8_000)
  content: string;
}

/** Búsqueda de prospectos en Apollo.io. Todos los filtros son opcionales,
 *  pero el service exige al menos uno (borde validado en ambos lados). */
export class SearchProspectsDto {
  @IsOptional() @IsString() @MaxLength(200)
  keywords?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(80, { each: true })
  titles?: string[];

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(80, { each: true })
  locations?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  @Matches(/^\d+,\d+$/, { each: true, message: 'employeeRanges usa el formato Apollo "min,max" (ej. "11,50").' })
  employeeRanges?: string[];

  @IsOptional() @IsInt() @Min(1) @Max(500)
  page?: number;
}

/** Márgenes por tier para finalizar la propuesta (form de márgenes del
 *  vendedor). `margins` = { "<tier>": { markup, coordination? } }. */
export class FinalizeProposalDto {
  @IsObject()
  margins: Record<string, { markup: number; coordination?: number }>;
}

/** Enriquecer un prospecto de Apollo (people/match — consume 1 crédito). */
export class EnrichProspectDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  id: string;
}

/** Guardar un prospecto de la búsqueda en el pipeline (enriquece + upsert).
 *  Los campos `preview*` son los que la búsqueda YA mostró en pantalla: sirven
 *  de respaldo si el enriquecimiento con Apollo falla (sin créditos, rate limit,
 *  API caída). Sin ellos el prospecto entraría vacío — ver el bug de 2026-07-30. */
export class SaveProspectDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  apolloId: string;

  @IsOptional() @IsString() @MaxLength(200)
  previewName?: string;

  @IsOptional() @IsString() @MaxLength(200)
  previewTitle?: string;

  @IsOptional() @IsString() @MaxLength(200)
  previewCompany?: string;

  @IsOptional() @IsString() @MaxLength(300)
  previewCompanyWebsite?: string;

  @IsOptional() @IsString() @MaxLength(200)
  previewIndustry?: string;

  @IsOptional() @IsString() @MaxLength(200)
  previewLocation?: string;

  @IsOptional() @IsString() @MaxLength(300)
  previewLinkedinUrl?: string;
}

/** Búsqueda de empresas en Datos Abiertos Colombia (fuente `web`, sin API key). */
export class OpenDataSearchDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  keywords: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsInt() @Min(1) @Max(50)
  limit?: number;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  offset?: number;
}

/** Guardar en el pipeline una empresa devuelta por la búsqueda anterior.
 *  Se reciben los campos ya resueltos para no repetir la consulta al dataset. */
export class SaveOpenDataDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name: string;

  @IsOptional() @IsString() @MaxLength(20)
  nit?: string;

  @IsOptional() @IsString() @MaxLength(50)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(150)
  email?: string;

  @IsOptional() @IsString() @MaxLength(250)
  address?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(80)
  department?: string;

  @IsOptional() @IsString() @MaxLength(150)
  domain?: string;

  @IsOptional() @IsString() @MaxLength(100)
  companyType?: string;

  @IsOptional() @IsString() @MaxLength(150)
  category?: string;
}

/** Búsqueda de EMPRESAS en Apollo (`organizations/search` — disponible en el
 *  plan Free, a diferencia de los endpoints de personas). */
export class ApolloOrgSearchDto {
  /** Sector del catálogo ('logistica', 'seguros'…). */
  @IsOptional() @IsString() @MaxLength(40)
  sector?: string;

  @IsOptional() @IsIn(['Startup', 'SMB', 'Enterprise'])
  segment?: string;

  /** Filtro de texto sobre la razón social, dentro del catálogo. */
  @IsOptional() @IsString() @MaxLength(80)
  text?: string;

  @IsOptional() @IsInt() @Min(1) @Max(50)
  limit?: number;
}

const PROSPECT_ETAPAS = [
  'contacto', 'reunion', 'propuesta', 'en-revision', 'aprobado-documentos',
  'aprobado-cerrado', 'perdido', 'frio', 'cambio-propuesta', 'no-calificado', 'recontactar',
];
const PROSPECT_ESTADOS = ['backlog', 'en-gestion', 'rechazado', 'aprobado'];

/** Nutrir un prospecto guardado (teléfono, email, notas, reintento, estado). */
export class UpdateProspectDto {
  /** Columna del tablero. Se manda al arrastrar la tarjeta; el backend
   *  deriva la etapa por defecto de esa columna. */
  @IsOptional() @IsIn(PROSPECT_ESTADOS)
  estado?: string;

  /** Etapa del proceso (las 11). Es la fuente de verdad: si viene, el backend
   *  recalcula el estado a partir de ella. */
  @IsOptional() @IsIn(PROSPECT_ETAPAS)
  etapa?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  email?: string;

  @IsOptional() @IsISO8601()
  nextAttemptAt?: string;

  @IsOptional() @IsString() @MaxLength(64)
  opportunityId?: string;
}

/** Registrar un intento de contacto (el estado transiciona solo). */
export class AddInteractionDto {
  @IsIn(['llamada', 'correo', 'whatsapp', 'linkedin', 'otro'])
  tipo: string;

  @IsIn(['sin-respuesta', 'contacto-logrado', 'reunion-agendada', 'referido', 'rechazado', 'ya-no-trabaja'])
  resultado: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notas?: string;

  @IsOptional() @IsString() @MaxLength(120)
  referidoNombre?: string;

  @IsOptional() @IsString() @MaxLength(160)
  referidoContacto?: string;

  @IsOptional() @IsISO8601()
  reintentarAt?: string;
}

/** Guardar una búsqueda para la corrida semanal. */
export class CreateSavedSearchDto {
  @IsOptional() @IsString() @MaxLength(200)
  keywords?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(80, { each: true })
  titles?: string[];

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(80, { each: true })
  locations?: string[];

  /** Qué motor corre la búsqueda semanal. Por defecto 'apollo' para no
   *  cambiarle el comportamiento a las que ya existen. */
  @IsOptional() @IsIn(['apollo', 'web'])
  source?: 'apollo' | 'web';

  /** Solo aplica a `web`: municipio del registro público. */
  @IsOptional() @IsString() @MaxLength(80)
  city?: string;
}

/** Alta manual de un contacto — el vendedor lo consiguió llamando. Gratis. */
export class AddContactDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(120)
  title?: string;

  @IsOptional() @IsString() @MaxLength(150)
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(300)
  linkedinUrl?: string;
}

/** Enviar la propuesta al TL para que la revise. */
export class TlReviewDto {
  @IsString() @IsNotEmpty() @MaxLength(150)
  @Matches(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, { message: 'tlEmail debe ser un correo válido.' })
  tlEmail: string;

  /** Fecha declarada por el vendedor: pudo haberla mandado ayer y registrarla
   *  hoy, así que no se usa la fecha del servidor. */
  @IsISO8601()
  sentAt: string;

  @IsOptional() @IsString() @MaxLength(2000)
  comments?: string;
}

/** Handoff al TL — el vendedor asigna el Owner TL (rules/13 §Cerrar el brief). */
export class HandoffDto {
  @IsOptional() @IsString() @MaxLength(80)
  @Matches(/^[\w-]+$/, { message: 'tlLogin debe ser un login de GitHub válido.' })
  tlLogin?: string;
}

/** Marcar notificaciones como vistas — sin ids marca TODAS las del que consulta. */
export class MarkNotificationsSeenDto {
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(64, { each: true })
  ids?: string[];
}

/** Ceder el proceso a otro vendedor (login de GitHub de team.json). */
export class TransferOpportunityDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(/^[\w-]+$/, { message: 'toLogin debe ser un login de GitHub válido.' })
  toLogin: string;
}
