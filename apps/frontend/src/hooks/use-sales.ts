import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  SalesOpportunity,
  SalesOpportunityDetail,
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

export function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { cliente: string; oportunidad: string }) =>
      api.post<SalesOpportunity>('/sales/opportunities', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales', 'opportunities'] }),
  });
}

export function useSendSalesMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.post<SalesSendMessageResult>(`/sales/opportunities/${id}/messages`, { content }),
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
