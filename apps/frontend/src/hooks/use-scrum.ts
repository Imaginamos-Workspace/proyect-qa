import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ScrumBoard, ScrumBoardSummary, ScrumCard } from '@qa/shared-types';

export interface ScrumMe {
  login: string | null;
  roles: string[];
  canMove: boolean;
}

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
    // Sin polling cada 60s (golpeaba el backend justo al expirar su caché → frío
    // garantizado). El board ya se actualiza optimista al mover y refetchea al
    // re-enfocar la ventana. Datos servidos al instante dentro de staleTime.
    staleTime: 5 * 60_000,
  });
}

/** El usuario actual: roles (team.json del monorepo) y si puede mover tarjetas. */
export function useScrumMe() {
  return useQuery({
    queryKey: ['scrum', 'me'],
    queryFn: () => api.get<ScrumMe>('/scrum/me'),
    staleTime: 5 * 60_000,
  });
}

/** Devuelve un board nuevo con la tarjeta `issue` movida a la columna `status`. */
function moveCardInBoard(board: ScrumBoard, issue: number, status: string): ScrumBoard {
  let moved: ScrumCard | undefined;
  const stripped = board.columns.map((c) => ({
    ...c,
    cards: c.cards.filter((card) => {
      if (card.number === issue) {
        moved = { ...card, status };
        return false;
      }
      return true;
    }),
  }));
  if (!moved) return board;
  const columns = stripped.map((c) =>
    c.key === status ? { ...c, cards: [moved as ScrumCard, ...c.cards] } : c,
  );
  return { ...board, columns };
}

/** Mover una tarjeta de columna (cambia el Status en el board), con update
 *  optimista y rollback si el backend rechaza (p. ej. sin permiso de rol). */
export function useMoveCard(slug: string) {
  const qc = useQueryClient();
  const key = ['scrum', 'boards', slug];
  return useMutation({
    mutationFn: ({ issue, status }: { issue: number; status: string }) =>
      api.post(`/scrum/boards/${slug}/move`, { issue, status }),
    onMutate: async ({ issue, status }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ScrumBoard>(key);
      if (prev) qc.setQueryData(key, moveCardInBoard(prev, issue, status));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}
