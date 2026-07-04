// Módulo Ventas: el vendedor llena el brief de una oportunidad chateando con
// un LLM desde la plataforma (rules/13 §Modo B/C del monorepo).
// Espejo de packages/shared-types/src/sales.types.ts (el backend mantiene su
// propia copia, igual que el resto de tipos).

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

export type SalesOpportunityStatus = 'brief' | 'propuesta-en-armado';

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

export type SalesMessageRole = 'vendor' | 'assistant';

export interface SalesMessage {
  id: string;
  opportunityId: string;
  role: SalesMessageRole;
  content: string;
  createdAt: string;
}

export interface SalesOpportunityDetail extends SalesOpportunity {
  messages: SalesMessage[];
}

export interface SalesSendMessageResult {
  reply: string;
  draft: SalesBriefDraft;
}

export interface SalesSyncResult {
  url: string;
  syncedAt: string;
}
