import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  SalesOpportunity,
  SalesOpportunityDetail,
  SalesProposalAccess,
  SalesProposalMetrics,
  SalesRegenerateProposalResult,
  SalesSendMessageResult,
  SalesSyncResult,
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

// La cascada de IA (Gemini flash→pro→Groq→DeepSeek, cada uno con reintentos
// y backoff) puede tardar legítimamente más de los 20s por defecto del
// cliente — el backend ya permite hasta 60s (vercel.json maxDuration). Sin
// este override, un mensaje que tarda 25-30s por una cascada real (no un
// cuelgue) se abortaba desde el navegador antes de que el backend terminara.
const SEND_MESSAGE_TIMEOUT_MS = 55_000;

export function useSendSalesMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.post<SalesSendMessageResult>(`/sales/opportunities/${id}/messages`, { content }, SEND_MESSAGE_TIMEOUT_MS),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities', id] }),
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
