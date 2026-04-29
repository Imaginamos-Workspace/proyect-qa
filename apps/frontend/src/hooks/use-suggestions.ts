import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  AISuggestion,
  AISuggestExploreRequest,
  AISuggestExploreResponse,
  AIConvertSuggestionResponse,
} from '@qa/shared-types';

/** List pending suggestions for a project. */
export function useSuggestions(projectId: string | null) {
  return useQuery<AISuggestion[]>({
    queryKey: ['suggestions', projectId],
    enabled: !!projectId,
    queryFn: () =>
      api.get<AISuggestion[]>(`/ai/suggestions/project/${projectId}`),
    staleTime: 30_000,
  });
}

/** Trigger site exploration → returns new suggestions. */
export function useExploreSite() {
  const qc = useQueryClient();
  return useMutation<AISuggestExploreResponse, Error, AISuggestExploreRequest>({
    mutationFn: (req) =>
      api.post<AISuggestExploreResponse>('/ai/suggestions/explore', req),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['suggestions', vars.project_id] });
      qc.invalidateQueries({ queryKey: ['test-cases'] });
    },
  });
}

/** Dismiss a suggestion (soft — keeps the row, sets status=dismissed). */
export function useDismissSuggestion(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation<AISuggestion, Error, string>({
    mutationFn: (id) =>
      api.post<AISuggestion>(`/ai/suggestions/${id}/dismiss`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suggestions', projectId] });
    },
  });
}

/** Hard delete (when the user wants it gone, not just dismissed). */
export function useDeleteSuggestion(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => api.delete<{ ok: boolean }>(`/ai/suggestions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suggestions', projectId] });
    },
  });
}

/** Turn a suggestion into a real test case. */
export function useConvertSuggestion(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation<AIConvertSuggestionResponse, Error, string>({
    mutationFn: (id) =>
      api.post<AIConvertSuggestionResponse>(
        `/ai/suggestions/${id}/convert`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['suggestions', projectId] });
      qc.invalidateQueries({ queryKey: ['test-cases'] });
      qc.invalidateQueries({ queryKey: ['test-suites'] });
    },
  });
}
