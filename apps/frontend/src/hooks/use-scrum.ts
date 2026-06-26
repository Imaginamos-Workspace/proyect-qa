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
    // Refresco de fondo para ver cambios de otros usuarios. Es barato: el backend
    // sirve del caché compartido (Supabase), no reconstruye desde GitHub salvo que
    // el TTL venza o alguien mueva una tarjeta (que invalida). Entrada instantánea
    // por staleTime; reconciliación cada 45s y al re-enfocar la ventana.
    staleTime: 45_000,
    refetchInterval: 45_000,
  });
}

export interface ScrumCreateMeta {
  configured: boolean;
  types: string[];
  areas: string[];
  priorities: string[];
  estimates: string[];
  sprints: string[];
}

export interface CreateIssueInput {
  title: string;
  type: string;
  description: string;
  acceptanceCriteria?: string;
  area?: string;
  priority?: string;
  estimate?: string;
  sprint?: string;
  startDate?: string;
  dueDate?: string;
  links?: string[];
  parentNumber?: number;
}

/** Opciones del formulario de creación (tipos/áreas/prioridades/estimaciones/sprints). */
export function useCreateMeta(slug: string) {
  return useQuery({
    queryKey: ['scrum', 'meta', slug],
    queryFn: () => api.get<ScrumCreateMeta>(`/scrum/boards/${slug}/meta`),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
}

/** Crea un issue en GitHub + el board del cliente; refresca el board al terminar. */
export function useCreateIssue(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIssueInput) =>
      api.post<{ ok: boolean; number: number; url: string }>(`/scrum/boards/${slug}/issues`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scrum', 'boards', slug] }),
  });
}

function patchCardDates(board: ScrumBoard, issue: number, startDate?: string, dueDate?: string): ScrumBoard {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) =>
        card.number === issue ? { ...card, startDate: startDate ?? card.startDate, dueDate: dueDate ?? card.dueDate } : card,
      ),
    })),
  };
}

/** Cambia las fechas Inicio/Fin de un issue (drag-resize del roadmap), con update
 *  optimista y rollback si el backend rechaza. */
export function useSetIssueDates(slug: string) {
  const qc = useQueryClient();
  const key = ['scrum', 'boards', slug];
  return useMutation({
    mutationFn: ({ issue, startDate, dueDate }: { issue: number; startDate?: string; dueDate?: string }) =>
      api.post(`/scrum/boards/${slug}/issues/${issue}/dates`, { startDate, dueDate }),
    onMutate: async ({ issue, startDate, dueDate }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ScrumBoard>(key);
      if (prev) qc.setQueryData(key, patchCardDates(prev, issue, startDate, dueDate));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
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
