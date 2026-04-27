import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  AIGenerateRequest,
  AIGenerateResponse,
  AIRefineRequest,
  AIRefineResponse,
  AICompleteTestRequest,
  AICompleteTestResponse,
  AIHealTokenResponse,
} from '@qa/shared-types';

export function useGenerateTests() {
  return useMutation({
    mutationFn: (request: AIGenerateRequest) =>
      api.post<AIGenerateResponse>('/ai/generate-tests', request),
  });
}

export function useRefineTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AIRefineRequest) =>
      api.post<AIRefineResponse>('/ai/refine-test', request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['test-cases'] });
      queryClient.invalidateQueries({ queryKey: ['test-case'] });
    },
  });
}

export function useCompleteTestCase() {
  return useMutation({
    mutationFn: (req: AICompleteTestRequest) =>
      api.post<AICompleteTestResponse>('/ai/complete-test-case', req),
  });
}

export function useAnalyzeUrl() {
  return useMutation({
    mutationFn: (body: { url: string; page_data: string }) =>
      api.post<string>('/ai/analyze-url', body),
  });
}

/**
 * Fetch a scoped heal token for a test case. The token is valid for 1 hour
 * and is required by /ai/heal-iterate (the public endpoint the bash script
 * calls). Auto-refreshes every 50 minutes when the modal stays open.
 */
export function useHealToken(testCaseId: string | null) {
  return useQuery<AIHealTokenResponse>({
    queryKey: ['heal-token', testCaseId],
    enabled: !!testCaseId,
    staleTime: 50 * 60 * 1000, // refresh 10 min before expiry
    refetchOnWindowFocus: false,
    queryFn: () =>
      api.post<AIHealTokenResponse>('/ai/heal-token', {
        test_case_id: testCaseId,
      }),
  });
}
