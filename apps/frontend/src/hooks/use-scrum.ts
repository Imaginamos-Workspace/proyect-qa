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

export interface ScrumIssueDetail {
  title: string;
  body: string;
  url: string;
  state: string;
  parent: { number: number; title: string } | null;
  subIssues: { number: number; title: string; state: string }[];
  comments: { author: string; body: string; createdAt: string }[];
}

/** Detalle completo del issue (cuerpo/comentarios/jerarquía) para el panel
 *  lateral — el resto (status/sprint/área/etc.) ya está en el ScrumCard. */
export function useIssueDetail(slug: string, issueNumber: number | null) {
  return useQuery({
    queryKey: ['scrum', 'boards', slug, 'issues', issueNumber, 'detail'],
    queryFn: () => api.get<ScrumIssueDetail>(`/scrum/boards/${slug}/issues/${issueNumber}/detail`),
    enabled: !!slug && issueNumber != null,
    staleTime: 30_000,
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
  points?: number;
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

// ─── Ciclo de vida de sprints ───────────────────────────────────────────────
export interface SprintState {
  title: string;
  status: 'active' | 'closed';
  started_at: string | null;
  closed_at: string | null;
  completed_points: number | null;
  total_points: number | null;
  carried_over: number;
}
export interface SprintStatus {
  title: string;
  total: number;
  done: number;
  unfinished: { number: number | null; title: string; status: string | null; url: string | null; points: number | null }[];
  total_points: number;
  done_points: number;
}

export function useSprintStates(slug: string) {
  return useQuery({
    queryKey: ['scrum', 'sprints', slug],
    queryFn: () => api.get<SprintState[]>(`/scrum/boards/${slug}/sprints`),
    enabled: !!slug,
    staleTime: 30_000,
  });
}

/** Estado de cierre de un sprint (issues sin terminar + puntos). Se pide al abrir el diálogo. */
export function useSprintStatus(slug: string, title: string, enabled: boolean) {
  return useQuery({
    queryKey: ['scrum', 'sprint-status', slug, title],
    queryFn: () => api.get<SprintStatus>(`/scrum/boards/${slug}/sprints/${encodeURIComponent(title)}/status`),
    enabled: !!slug && !!title && enabled,
  });
}

function invalidateSprints(qc: ReturnType<typeof useQueryClient>, slug: string) {
  qc.invalidateQueries({ queryKey: ['scrum', 'sprints', slug] });
  qc.invalidateQueries({ queryKey: ['scrum', 'boards', slug] });
  qc.invalidateQueries({ queryKey: ['scrum', 'sprint-status', slug] });
}

export function useStartSprint(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.post(`/scrum/boards/${slug}/sprints/${encodeURIComponent(title)}/start`),
    onSuccess: () => invalidateSprints(qc, slug),
  });
}

export function useCloseSprint(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.post(`/scrum/boards/${slug}/sprints/${encodeURIComponent(title)}/close`),
    onSuccess: () => invalidateSprints(qc, slug),
  });
}

/** Carry-over de varios issues. `to` opcional — si no se pasa, el backend usa
 *  el siguiente sprint por orden cronológico. El backend procesa como máximo
 *  50 por llamada; la respuesta trae `remaining` si hay que repetir la acción. */
export function useCarryOver(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title, issues, to }: { title: string; issues: number[]; to?: string }) =>
      api.post<{ moved: number; remaining: number; failed: number[]; to: string }>(
        `/scrum/boards/${slug}/sprints/${encodeURIComponent(title)}/carry-over`,
        { issues, to },
      ),
    onSuccess: () => invalidateSprints(qc, slug),
  });
}

/** Asigna/cambia el sprint de UN issue puntual (dropdown por tarjeta). */
export function useAssignSprint(slug: string) {
  const qc = useQueryClient();
  const key = ['scrum', 'boards', slug];
  return useMutation({
    mutationFn: ({ issue, title }: { issue: number; title: string }) =>
      api.post(`/scrum/boards/${slug}/issues/${issue}/sprint`, { title }),
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
