// Modelo normalizado del board de scrum (origen: GitHub Projects v2).
// Espejo de packages/shared-types/src/scrum.types.ts (el backend mantiene su
// propia copia, igual que el resto de tipos).

export type ScrumIssueType = 'epic' | 'story' | 'task' | 'bug' | 'spike' | 'unknown';
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
  updated_at: string;
}

export interface ScrumBoardSummary {
  client_slug: string;
  client_name: string;
}
