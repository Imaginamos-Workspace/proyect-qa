import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ScrumBoard, ScrumBoardSummary } from '@qa/shared-types';

export function useScrumBoards() {
  return useQuery({
    queryKey: ['scrum', 'boards'],
    queryFn: () => api.get<ScrumBoardSummary[]>('/scrum/boards'),
  });
}

export function useScrumBoard(slug: string) {
  return useQuery({
    queryKey: ['scrum', 'boards', slug],
    queryFn: () => api.get<ScrumBoard>(`/scrum/boards/${slug}`),
    enabled: !!slug,
    refetchInterval: 60_000,
  });
}
