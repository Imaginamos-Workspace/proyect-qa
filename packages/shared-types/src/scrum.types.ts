// Modelo normalizado del board de scrum (origen: GitHub Projects v2).
// El backend (ScrumModule) lo arma desde la API de GitHub; el frontend lo
// renderiza como un kanban estilo Jira.

export type ScrumIssueType = 'epic' | 'story' | 'task' | 'bug' | 'spike' | 'unknown';
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
  updated_at: string;
}

export interface ScrumBoardSummary {
  client_slug: string;
  client_name: string;
}
