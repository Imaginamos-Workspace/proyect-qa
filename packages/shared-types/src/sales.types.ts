// Módulo Ventas: el vendedor llena el brief de una oportunidad chateando con
// un LLM desde la plataforma (rules/13 §Modo B/C del monorepo).

export interface SalesBriefAsuncion {
  texto: string;
  impactoSiFalla: string;
}

// Shape flexible a propósito — mapea las secciones de sales/templates/brief.md
// como texto libre (el LLM redacta cada sección), salvo `asunciones` que
// necesita el campo estructurado impactoSiFalla (rules/13).
export interface SalesBriefDraft {
  cliente?: string;
  problema?: string;
  outcomes?: string;
  usuariosYFuncionalidades?: string;
  limites?: string;
  integraciones?: string;
  asunciones?: SalesBriefAsuncion[];
  riesgos?: string;
  sensacionVendedor?: string;
}

// El estado real completo lo define la state machine de rules/13 (status.md):
// brief → propuesta-en-armado → propuesta-enviada → negociacion → ganada/perdida/congelada.
// Se deja como string (no un union estricto) porque el dueño de esos valores
// es el monorepo, no esta plataforma — no queremos romper si el monorepo
// agrega/renombra un estado.
export type SalesOpportunityStatus = string;

export interface SalesOpportunity {
  id: string;
  cliente: string;
  oportunidad: string;
  vendedorLogin: string;
  status: SalesOpportunityStatus;
  draft: SalesBriefDraft;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// 'system' = notas del propio pipeline (proceso cedido/reclamado), no las
// escribe ni el vendedor ni el LLM — se muestran como línea de sistema.
export type SalesMessageRole = 'vendor' | 'assistant' | 'system';

export interface SalesMessage {
  id: string;
  opportunityId: string;
  role: SalesMessageRole;
  content: string;
  createdAt: string;
}

export interface SalesOpportunityDetail extends SalesOpportunity {
  messages: SalesMessage[];
  // Propiedad del proceso (rules/13): solo el dueño abre el chat y edita.
  // isOwner = el que consulta es el vendedor_login de la oportunidad.
  // locked = tiene dueño y NO soy yo → chat oculto (messages viene vacío).
  // canClaim = sin dueño real ('desconocido'/vacío) → cualquiera puede
  //   reclamarlo para volverse el dueño.
  isOwner: boolean;
  locked: boolean;
  canClaim: boolean;
}

// Vendedor elegible para recibir un proceso cedido (de team.json del monorepo).
export interface SalesVendedor {
  login: string;
  name: string | null;
}

export interface SalesOwnershipResult {
  vendedorLogin: string;
}

export interface SalesSendMessageResult {
  reply: string;
  draft: SalesBriefDraft;
}

export interface SalesSyncResult {
  url: string;
  syncedAt: string;
}

// generated=false → no hay deploy real (ni access.json ni contenido en vivo).
// password=null → la propuesta está publicada y en vivo, pero SIN
// contraseña registrada en el repo (hueco de seguridad real — rules/13
// exige contraseña siempre; ver rules/13 §Contraseña por propuesta).
export type SalesProposalAccess =
  | { generated: false }
  | {
      generated: true;
      url: string;
      password: string | null;
      createdAt?: string;
      createdBy?: string | null;
    };

export interface SalesProposalMetrics {
  totalViews: number;
  lastViewedAt: string | null;
}

// --- Notificaciones del pipeline (migración 025) ---------------------------
// El discovery detecta transiciones de status.md (el TL publicó la propuesta,
// negociación, ganada, congelada por tiempo, diseño/desarrollo…) y crea una
// notificación para el vendedor dueño, con CTA directo a la acción que sigue.

export interface SalesNotification {
  id: string;
  opportunityId: string;
  /** "status:<etapa>" — extensible a otros orígenes de evento. */
  type: string;
  title: string;
  body: string | null;
  ctaLabel: string | null;
  /** Ruta interna de la plataforma (ej. "/ventas/<id>?tab=propuesta"). */
  ctaPath: string | null;
  seen: boolean;
  createdAt: string;
}

export interface SalesNotificationsResult {
  notifications: SalesNotification[];
  unseenCount: number;
}

// --- Prospección (Apollo.io) ---------------------------------------------
// Búsqueda de prospectos B2B desde la plataforma. La API key vive SOLO en el
// backend (APOLLO_API_KEY) — el frontend consulta `configured` para saber si
// el flujo está activo y mostrar la guía de configuración si falta.

export interface SalesProspectsStatus {
  configured: boolean;
}

export interface SalesProspectSearchInput {
  /** Texto libre (nombre, empresa, industria…). */
  keywords?: string;
  /** Cargos a buscar (ej. "CEO", "Gerente de operaciones"). */
  titles?: string[];
  /** Ubicaciones de la persona (ej. "Bogotá", "Colombia"). */
  locations?: string[];
  /** Rangos de empleados de la empresa en formato Apollo: "1,10", "11,50"… */
  employeeRanges?: string[];
  page?: number;
}

export interface SalesProspect {
  id: string;
  name: string;
  title: string | null;
  company: string | null;
  companyWebsite: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
  /** Apollo bloquea el email hasta que se enriquece (crédito) — puede venir null. */
  email: string | null;
}

export interface SalesProspectSearchResult {
  prospects: SalesProspect[];
  page: number;
  totalPages: number;
  totalEntries: number;
  /** apollo_ids que YA están guardados en el pipeline del que busca —
   *  para pintar "Guardado ✓" y no re-guardar (idempotencia visible). */
  savedApolloIds: string[];
}

// --- Pipeline de prospección (migración 026) -------------------------------
// Etapa intermedia entre la búsqueda y la oportunidad: guardar → contactar →
// registrar intentos/referidos/reintentos → convertir en oportunidad.

export type SavedProspectEstado =
  | 'por-contactar'
  | 'en-seguimiento'
  | 'contactado'
  | 'reunion-agendada'
  | 'referido'
  | 'descartado'
  | 'convertido';

export interface SavedProspect {
  id: string;
  apolloId: string;
  estado: SavedProspectEstado;
  origen: 'manual' | 'semanal' | 'referido';
  name: string;
  title: string | null;
  company: string | null;
  companyWebsite: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  nextAttemptAt: string | null;
  opportunityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProspectInteractionTipo = 'llamada' | 'correo' | 'whatsapp' | 'linkedin' | 'otro';
export type ProspectInteractionResultado =
  | 'sin-respuesta'
  | 'contacto-logrado'
  | 'reunion-agendada'
  | 'referido'
  | 'rechazado'
  | 'ya-no-trabaja';

export interface ProspectInteraction {
  id: string;
  prospectId: string;
  tipo: ProspectInteractionTipo;
  resultado: ProspectInteractionResultado;
  notas: string | null;
  referidoNombre: string | null;
  referidoContacto: string | null;
  reintentarAt: string | null;
  createdAt: string;
}

export interface SavedProspectSearch {
  id: string;
  keywords: string | null;
  titles: string[];
  locations: string[];
  active: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface SalesRegenerateProposalResult {
  dispatched: true;
}
