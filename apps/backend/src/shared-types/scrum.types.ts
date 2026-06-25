// Modelo normalizado del board de scrum (origen: GitHub Projects v2).
// Espejo de packages/shared-types/src/scrum.types.ts (el backend mantiene su
// propia copia, igual que el resto de tipos).

export type ScrumIssueType = 'epic' | 'story' | 'task' | 'bug' | 'incident' | 'spike' | 'unknown';
export type ScrumPriority = 'high' | 'medium' | 'low' | null;

export interface ScrumAssignee {
  login: string;
  avatarUrl: string | null;
}

export interface ScrumCard {
  id: string;
  number: number | null;
  title: string;
  url: string | null;
  type: ScrumIssueType;
  status: string | null;
  area: string | null;
  priority: ScrumPriority;
  estimate: string | null;
  sprint: string | null;
  labels: string[];
  assignees: ScrumAssignee[];
}

export interface ScrumColumn {
  key: string;
  title: string;
  cards: ScrumCard[];
}

export interface ScrumEpic {
  number: number | null;
  title: string;
  url: string | null;
}

export interface ScrumSprint {
  title: string;
  startDate: string | null; // ISO yyyy-mm-dd
  endDate: string | null; // ISO yyyy-mm-dd (start + duración)
  completed: boolean; // true = cerrado (iteración completada) · false = abierto
}

/** Resumen de pruebas ligado a una historia (#N del issue) — última corrida. */
export interface ScrumStoryTests {
  story: number;
  total: number;
  passed: number;
  failed: number;
}

/** Trazabilidad de la última corrida de QA, para pintar pruebas/evidencia en el board. */
export interface ScrumQaInfo {
  report_url: string | null; // evidencia (reporte HTML)
  run_at: string | null;
  story_map: ScrumStoryTests[]; // historias CON pruebas y su resultado
  unmapped_tests: string[]; // pruebas SIN historia ligada (mapeo pendiente)
}

export interface ScrumBoard {
  client_slug: string;
  client_name: string;
  configured: boolean;
  reason: string | null;
  project_number: number | null;
  project_url: string | null;
  columns: ScrumColumn[];
  epics: ScrumEpic[];
  sprints: string[];
  sprintsMeta: ScrumSprint[]; // fechas + estado abierto/cerrado de cada sprint
  members: ScrumAssignee[]; // usuarios asignables del repo (miembros de la org)
  qa: ScrumQaInfo | null; // trazabilidad pruebas↔historias de la última corrida
  updated_at: string;
}

export interface ScrumBoardSummary {
  client_slug: string;
  client_name: string;
}
