// Modelo normalizado del board de scrum (origen: GitHub Projects v2).
// El backend (ScrumModule) lo arma desde la API de GitHub; el frontend lo
// renderiza como un kanban estilo Jira.

export type ScrumIssueType = 'epic' | 'story' | 'task' | 'bug' | 'incident' | 'spike' | 'unknown';
export type ScrumPriority = 'high' | 'medium' | 'low' | null;

export interface ScrumAssignee {
  login: string;
  avatarUrl: string | null;
}

export interface ScrumCard {
  id: string;
  number: number | null; // número del issue (#N)
  title: string;
  url: string | null;
  type: ScrumIssueType;
  status: string | null;
  area: string | null;
  priority: ScrumPriority;
  estimate: string | null; // S/M/L/XL
  sprint: string | null;
  labels: string[];
  assignees: ScrumAssignee[];
}

export interface ScrumColumn {
  key: string; // nombre del estado (Status)
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
  configured: boolean; // false si falta token o no se halló el board del cliente
  reason: string | null; // por qué no está configurado (para guiar al usuario)
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
