import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  SalesMessage,
  SalesNotificationsResult,
  SalesOpportunity,
  SalesOpportunityDetail,
  SalesOwnershipResult,
  SalesProposalAccess,
  SalesProposalMetrics,
  SalesProposalTiersResult,
  ProspectInteraction,
  SalesProspect,
  SalesProspectSearchInput,
  SalesProspectSearchResult,
  SalesProspectsStatus,
  SavedProspect,
  SavedProspectSearch,
  SalesRegenerateProposalResult,
  SalesSendMessageResult,
  SalesSyncResult,
  SalesVendedor,
  OpenDataCompany,
  ProspectSources,
  ApolloOrgSearchResult,
  ProspectContact,
  ProspectContactsResult,
  ProspectTlReview,
  OpenDataSearchResult,
} from '@qa/shared-types';

export function useSalesOpportunities() {
  return useQuery({
    queryKey: ['sales', 'opportunities'],
    queryFn: () => api.get<SalesOpportunity[]>('/sales/opportunities'),
  });
}

export function useSalesOpportunity(id: string | null) {
  return useQuery({
    queryKey: ['sales', 'opportunities', id],
    queryFn: () => api.get<SalesOpportunityDetail>(`/sales/opportunities/${id}`),
    enabled: !!id,
    staleTime: 10_000,
    // El pipeline del header debe moverse SOLO cuando el TL avanza status.md
    // (el discovery lo re-sincroniza) — sin esto había que recargar la página.
    refetchInterval: 45_000,
  });
}

/** Link + contraseña de la propuesta ya generada (si existe). `refetchInterval`
 *  se usa mientras se está regenerando, para detectar la contraseña nueva
 *  apenas termine el workflow de CI (~1-2 min). */
export function useProposalAccess(id: string | null, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: ['sales', 'opportunities', id, 'proposal'],
    queryFn: () => api.get<SalesProposalAccess>(`/sales/opportunities/${id}/proposal`),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval,
  });
}

/** Total de aperturas + última fecha (métricas reales, worker de qa-proposals). */
export function useProposalMetrics(id: string | null) {
  return useQuery({
    queryKey: ['sales', 'opportunities', id, 'proposal', 'metrics'],
    queryFn: () => api.get<SalesProposalMetrics>(`/sales/opportunities/${id}/proposal/metrics`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

/** Los 3 tiers del TL con su markup/coordinación — para el form de márgenes. */
export function useProposalTiers(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['sales', 'opportunities', id, 'proposal', 'tiers'],
    queryFn: () => api.get<SalesProposalTiersResult>(`/sales/opportunities/${id}/proposal/tiers`),
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
}

/** Finaliza la propuesta con los márgenes del vendedor (dispara CI ~1-2 min). */
export function useFinalizeProposal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (margins: Record<string, { markup: number; coordination?: number }>) =>
      // 60s: el backend genera la narrativa (Gemini) + commitea antes de
      // disparar el workflow — puede pasar los 20s por defecto. maxDuration=60.
      api.post<SalesRegenerateProposalResult>(`/sales/opportunities/${id}/proposal/finalize`, { margins }, 60_000),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id, 'proposal'] }),
  });
}

/** Regenera la contraseña y vuelve a publicar (dispara CI, ~1-2 min). */
export function useRegenerateProposal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SalesRegenerateProposalResult>(`/sales/opportunities/${id}/proposal/regenerate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id, 'proposal'] }),
  });
}

export function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { cliente: string; oportunidad: string }) =>
      api.post<SalesOpportunity>('/sales/opportunities', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] }),
  });
}

export interface AiProviderHealth {
  provider: string;
  configured: boolean;
  ok: boolean;
  ms: number | null;
  error?: string;
}

/** Diagnóstico en vivo de los proveedores de IA (Gemini/Groq/DeepSeek). Se
 *  dispara a mano (cuesta un poco de cuota) — muestra cuál responde y en cuánto. */
export function useAiHealth() {
  return useMutation({
    mutationFn: () => api.get<AiProviderHealth[]>('/ai/health'),
  });
}

/** Reconstruye la base de conocimiento del RAG (metodología + negocios
 *  ganados). Idempotente — puede tardar unos segundos (embeddings). */
export function useReindexKnowledge() {
  return useMutation({
    mutationFn: () =>
      api.post<{ methodology: number; wonDeals: number }>('/sales/rag/reindex', undefined, 60_000),
  });
}

/** Notificaciones del pipeline (el TL publicó la propuesta, negociación,
 *  ganada, congelada…). Se refrescan solas cada 60s — misma frecuencia con la
 *  que el discovery puede detectar transiciones nuevas. */
export function useSalesNotifications() {
  return useQuery({
    queryKey: ['sales', 'notifications'],
    queryFn: () => api.get<SalesNotificationsResult>('/sales/notifications'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Marca notificaciones como vistas (sin ids = todas las mías). */
export function useMarkNotificationsSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.post<{ ok: true }>('/sales/notifications/seen', ids?.length ? { ids } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'notifications'] }),
  });
}

/** ¿Está configurada la API key de Apollo en el backend? Decide si el tab de
 *  prospectos muestra el buscador real o la guía de configuración. */
export function useProspectsStatus() {
  return useQuery({
    queryKey: ['sales', 'prospects', 'status'],
    queryFn: () => api.get<SalesProspectsStatus>('/sales/prospects/status'),
    staleTime: 5 * 60_000,
  });
}

/** Búsqueda de prospectos en Apollo.io (solo vendedor). Mutation y no query:
 *  cada búsqueda consume cuota del plan de Apollo — se dispara a mano. */
export function useSearchProspects() {
  return useMutation({
    mutationFn: (input: SalesProspectSearchInput) =>
      api.post<SalesProspectSearchResult>('/sales/prospects/search', input, 25_000),
  });
}

/** Desbloquea el dato completo de un prospecto (people/match de Apollo —
 *  consume 1 crédito). Se usa al elegir un prospecto para abrir oportunidad. */
export function useEnrichProspect() {
  return useMutation({
    mutationFn: (id: string) => api.post<SalesProspect>('/sales/prospects/enrich', { id }, 25_000),
  });
}

// ── Pipeline de prospección (etapa intermedia búsqueda → oportunidad) ──────

export function useSavedProspects() {
  return useQuery({
    queryKey: ['sales', 'prospects', 'saved'],
    queryFn: () => api.get<SavedProspect[]>('/sales/prospects/saved'),
    staleTime: 30_000,
  });
}

/** Guarda un prospecto en el pipeline (enriquece 1 crédito + upsert idempotente).
 *  Manda además lo que la búsqueda YA mostró en pantalla: si Apollo no puede
 *  enriquecer (sin créditos, rate limit, caído), el prospecto entra con esos
 *  datos en vez de quedar en "(por confirmar) / Sin empresa". */
export function useSaveProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: SalesProspect) =>
      api.post<SavedProspect>(
        '/sales/prospects/save',
        {
          apolloId: p.id,
          previewName: p.name ?? undefined,
          previewTitle: p.title ?? undefined,
          previewCompany: p.company ?? undefined,
          previewCompanyWebsite: p.companyWebsite ?? undefined,
          previewIndustry: p.industry ?? undefined,
          previewLocation: p.location ?? undefined,
          previewLinkedinUrl: p.linkedinUrl ?? undefined,
        },
        25_000,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'saved'] }),
  });
}

/** Nutrir datos / cambiar estado de un prospecto guardado. */
export function useUpdateProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Pick<SavedProspect, 'estado' | 'etapa' | 'notes' | 'phone' | 'email' | 'nextAttemptAt' | 'opportunityId'>>) =>
      api.post<SavedProspect>(`/sales/prospects/saved/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'saved'] }),
  });
}

/** Desbloquea el dato completo de un prospecto guardado (1 crédito Apollo) —
 *  para los que entraron por la corrida semanal con solo la vista previa. */
export function useEnrichSavedProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SavedProspect>(`/sales/prospects/saved/${id}/enrich`, undefined, 25_000),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'saved'] }),
  });
}

export function useProspectInteractions(id: string | null) {
  return useQuery({
    queryKey: ['sales', 'prospects', 'interactions', id],
    queryFn: () => api.get<ProspectInteraction[]>(`/sales/prospects/saved/${id}/interactions`),
    enabled: !!id,
  });
}

/** Registra un intento de contacto — el estado del prospecto transiciona solo. */
export function useAddInteraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; tipo: string; resultado: string; notas?: string; referidoNombre?: string; referidoContacto?: string; reintentarAt?: string }) =>
      api.post<{ interaction: ProspectInteraction; prospect: SavedProspect; referral: SavedProspect | null }>(`/sales/prospects/saved/${id}/interactions`, input),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'saved'] });
      qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'interactions', vars.id] });
    },
  });
}

export function useSavedSearches() {
  return useQuery({
    queryKey: ['sales', 'prospects', 'searches'],
    queryFn: () => api.get<SavedProspectSearch[]>('/sales/prospects/searches'),
    staleTime: 60_000,
  });
}

/** Guarda la búsqueda actual para la corrida semanal (cron de Vercel, lunes). */
export function useCreateSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      keywords?: string;
      titles?: string[];
      locations?: string[];
      /** 'apollo' (default) o 'web' — qué motor corre la búsqueda semanal. */
      source?: 'apollo' | 'web';
      /** Solo para 'web': municipio del registro público. */
      city?: string;
    }) => api.post<SavedProspectSearch>('/sales/prospects/searches', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'searches'] }),
  });
}

export function useDeleteSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: true }>(`/sales/prospects/searches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'searches'] }),
  });
}

/** Vendedores elegibles para recibir un proceso cedido (team.json). */
export function useVendedores() {
  return useQuery({
    queryKey: ['sales', 'vendedores'],
    queryFn: () => api.get<SalesVendedor[]>('/sales/vendedores'),
    staleTime: 5 * 60_000,
  });
}

/** Reclama un proceso sin dueño ('desconocido'/legacy) — el que reclama se
 *  vuelve el vendedor y a partir de ahí puede abrir el chat. */
export function useClaimOpportunity(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SalesOwnershipResult>(`/sales/opportunities/${id}/claim`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] });
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] });
    },
  });
}

/** Cede el proceso a otro vendedor (el histórico viaja con él). Tras ceder, el
 *  que cedió pierde el acceso — el detalle queda bloqueado. */
export function useTransferOpportunity(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toLogin: string) =>
      api.post<SalesOwnershipResult>(`/sales/opportunities/${id}/transfer`, { toLogin }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] });
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] });
    },
  });
}

// La cascada de IA (Gemini flash→pro→Groq→DeepSeek, cada uno con reintentos
// y backoff) puede tardar legítimamente más de los 20s por defecto del
// cliente — el backend ya permite hasta 60s (vercel.json maxDuration). Sin
// este override, un mensaje que tarda 25-30s por una cascada real (no un
// cuelgue) se abortaba desde el navegador antes de que el backend terminara.
const SEND_MESSAGE_TIMEOUT_MS = 55_000;

/** Manda un mensaje del vendedor y la respuesta del LLM, con update
 *  optimista — el mensaje del vendedor aparece al instante (no espera la
 *  ida y vuelta de red) y la respuesta se pinta apenas llega, sin esperar
 *  un segundo refetch de la oportunidad completa (eso pasaba antes: un
 *  salto/flash entre "Pensando…" desapareciendo y el mensaje apareciendo).
 *  Se invalida en segundo plano igual, para reconciliar con los ids/fechas
 *  reales que ya quedaron persistidos — pero eso no bloquea la UI. */
export function useSendSalesMessage(id: string) {
  const qc = useQueryClient();
  const key = ['sales', 'opportunities', id];

  return useMutation({
    mutationFn: (content: string) =>
      api.post<SalesSendMessageResult>(`/sales/opportunities/${id}/messages`, { content }, SEND_MESSAGE_TIMEOUT_MS),
    onMutate: async (content) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<SalesOpportunityDetail>(key);
      if (prev) {
        const optimisticVendorMsg: SalesMessage = {
          id: `optimistic-${Date.now()}`,
          opportunityId: id,
          role: 'vendor',
          content,
          createdAt: new Date().toISOString(),
        };
        qc.setQueryData(key, { ...prev, messages: [...prev.messages, optimisticVendorMsg] });
      }
      return { prev };
    },
    onSuccess: (result) => {
      const current = qc.getQueryData<SalesOpportunityDetail>(key);
      if (current) {
        const assistantMsg: SalesMessage = {
          id: `optimistic-reply-${Date.now()}`,
          opportunityId: id,
          role: 'assistant',
          content: result.reply,
          createdAt: new Date().toISOString(),
        };
        qc.setQueryData(key, { ...current, draft: result.draft, messages: [...current.messages, assistantMsg] });
      }
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (_err, _content, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
  });
}

/** El vendedor marca la propuesta como enviada al cliente (rules/13: acción
 *  suya, no del TL) — mueve el proceso a propuesta-enviada con bitácora. */
export function useMarkProposalSent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SalesOpportunity>(`/sales/opportunities/${id}/mark-sent`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] });
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] });
    },
  });
}

export function useSyncBrief(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SalesSyncResult>(`/sales/opportunities/${id}/sync-brief`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] }),
  });
}

export function useHandoffToTl(id: string) {
  const qc = useQueryClient();
  return useMutation({
    // El vendedor elige a qué TL pasa el brief (rules/13: él asigna Owner TL).
    mutationFn: (tlLogin?: string) =>
      api.post<SalesSyncResult>(`/sales/opportunities/${id}/handoff`, tlLogin ? { tlLogin } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] });
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] });
    },
  });
}

/** Team Leads elegibles para el handoff (team.json). */
export function useTls() {
  return useQuery({
    queryKey: ['sales', 'tls'],
    queryFn: () => api.get<SalesVendedor[]>('/sales/tls'),
    staleTime: 5 * 60_000,
  });
}

/** Borra la oportunidad COMPLETA: archivos del monorepo (sales/<cliente>/
 *  <oportunidad>/**) + fila de Supabase. No reversible desde la plataforma. */
export function useDeleteOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: true; filesDeleted: number }>(`/sales/opportunities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] }),
  });
}

// ── Fuente WEB: Datos Abiertos Colombia ─────────────────────────────────────

/** Qué fuentes de prospección están operativas (Apollo puede estar sin plan). */
export function useProspectSources() {
  return useQuery({
    queryKey: ['sales', 'prospects', 'sources'],
    queryFn: () => api.get<ProspectSources>('/sales/prospects/sources'),
    staleTime: 5 * 60_000,
  });
}

/** Busca empresas colombianas en el registro público (SECOP II).
 *  A diferencia de Apollo, no consume créditos ni cuota. */
export function useOpenDataSearch() {
  return useMutation({
    mutationFn: (input: { keywords: string; city?: string; limit?: number; offset?: number }) =>
      api.post<OpenDataSearchResult>('/sales/prospects/opendata/search', input, 25_000),
  });
}

/** Guarda una de esas empresas en el pipeline (idempotente por NIT). */
export function useSaveOpenDataCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: OpenDataCompany) =>
      api.post<{ saved: boolean; reason?: string }>('/sales/prospects/opendata/save', c),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'saved'] }),
  });
}

/** Busca EMPRESAS en Apollo. Este endpoint sí funciona en el plan Free —
 *  los de personas dan 403 — y no consume créditos. */
export function useApolloOrgSearch() {
  return useMutation({
    mutationFn: (input: { keywords: string[]; locations?: string[]; employeeRanges?: string[]; page?: number }) =>
      api.post<ApolloOrgSearchResult>('/sales/prospects/apollo-orgs/search', input, 30_000),
  });
}

// ── Contactos de un prospecto ───────────────────────────────────────────────

/** Personas de la empresa. Se pide al ABRIR el prospecto para trabajarlo —
 *  es el único punto que puede consumir créditos, y solo la primera vez:
 *  después sale de nuestra base (`fromCache: true`). */
export function useProspectContacts(prospectId: string | null) {
  return useQuery({
    queryKey: ['sales', 'prospects', 'contacts', prospectId],
    queryFn: () => api.get<ProspectContactsResult>(`/sales/prospects/saved/${prospectId}/contacts`),
    enabled: !!prospectId,
    // Una vez enriquecido el dato no cambia solo: no tiene sentido refrescar.
    staleTime: Infinity,
  });
}

/** Alta manual de un contacto — gratis, y es el camino mientras el plan de
 *  Apollo no habilite la búsqueda de personas. */
export function useAddProspectContact(prospectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; title?: string; email?: string; phone?: string; linkedinUrl?: string }) =>
      api.post<ProspectContact>(`/sales/prospects/saved/${prospectId}/contacts`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'contacts', prospectId] }),
  });
}

// ── Envíos de la propuesta al TL ────────────────────────────────────────────

/** Historial de revisiones: la propuesta puede volver al TL si el cliente
 *  pide cambios, así que son varias, no una. */
export function useTlReviews(prospectId: string | null) {
  return useQuery({
    queryKey: ['sales', 'prospects', 'tl-reviews', prospectId],
    queryFn: () => api.get<ProspectTlReview[]>(`/sales/prospects/saved/${prospectId}/tl-reviews`),
    enabled: !!prospectId,
  });
}

export function useAddTlReview(prospectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { tlEmail: string; sentAt: string; comments?: string }) =>
      api.post<ProspectTlReview>(`/sales/prospects/saved/${prospectId}/tl-reviews`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'prospects', 'tl-reviews', prospectId] }),
  });
}
