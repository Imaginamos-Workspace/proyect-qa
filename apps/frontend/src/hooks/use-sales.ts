import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  SalesMessage,
  SalesOpportunity,
  SalesOpportunityDetail,
  SalesOwnershipResult,
  SalesProposalAccess,
  SalesProposalMetrics,
  SalesRegenerateProposalResult,
  SalesSendMessageResult,
  SalesSyncResult,
  SalesVendedor,
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
    mutationFn: () => api.post<SalesSyncResult>(`/sales/opportunities/${id}/handoff`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] });
      qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] });
    },
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
