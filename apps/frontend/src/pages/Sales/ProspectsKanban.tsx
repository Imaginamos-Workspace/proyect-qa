import { Building2, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface MockProspect {
  company: string;
  contact: string;
  role: string;
  industry: string;
  score: number;
}

interface MockColumn {
  key: string;
  label: string;
  prospects: MockProspect[];
}

// Datos de ejemplo — esta vista es un MOCKUP de la Fase 2 (integración con
// Apollo.io). Todavía no hay fuente de datos real; el layout sirve para
// validar la estructura del kanban de prospección antes de conectarlo.
const MOCK_COLUMNS: MockColumn[] = [
  {
    key: 'por-contactar',
    label: 'Por contactar',
    prospects: [
      { company: 'Ferretería del Valle', contact: 'Marcela Ríos', role: 'Gerente General', industry: 'Retail', score: 62 },
      { company: 'Grupo Andino Logística', contact: 'Felipe Ortiz', role: 'Director de Operaciones', industry: 'Logística', score: 78 },
      { company: 'Clínica Bienestar+', contact: 'Dra. Lucía Peña', role: 'Directora Médica', industry: 'Salud', score: 55 },
    ],
  },
  {
    key: 'contactado',
    label: 'Contactado',
    prospects: [
      { company: 'Textiles Norte', contact: 'Andrés Molina', role: 'CFO', industry: 'Manufactura', score: 71 },
      { company: 'EduSmart Colombia', contact: 'Paula Castaño', role: 'Head of Growth', industry: 'EdTech', score: 84 },
    ],
  },
  {
    key: 'calificado',
    label: 'Calificado',
    prospects: [
      { company: 'Autopartes del Caribe', contact: 'Jorge Salcedo', role: 'Gerente Comercial', industry: 'Automotriz', score: 91 },
    ],
  },
  {
    key: 'reunion-agendada',
    label: 'Reunión agendada',
    prospects: [
      { company: 'Café Sierra Nevada Export', contact: 'Diana Caro', role: 'CEO', industry: 'Agroindustria', score: 88 },
    ],
  },
  {
    key: 'descartado',
    label: 'Descartado',
    prospects: [
      { company: 'Constructora Los Robles', contact: 'Iván Prieto', role: 'Gerente de Proyectos', industry: 'Construcción', score: 34 },
    ],
  },
];

function scoreVariant(score: number): 'success' | 'warning' | 'secondary' {
  if (score >= 75) return 'success';
  if (score >= 55) return 'warning';
  return 'secondary';
}

export function ProspectsKanban() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-4 py-3">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Vista previa — Fase 2.</span>{' '}
          Los prospectos de acá van a venir automáticamente de Apollo.io. Por ahora son datos de
          ejemplo para validar el layout antes de conectar la fuente real.
        </p>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-2">
        {MOCK_COLUMNS.map((col) => (
          <div key={col.key} className="w-72 shrink-0">
            <div className="mb-3 flex items-center justify-between px-1">
              <p className="text-sm font-semibold text-foreground">{col.label}</p>
              <Badge variant="secondary">{col.prospects.length}</Badge>
            </div>
            <div className="space-y-3">
              {col.prospects.map((p, i) => (
                <Card key={i} className="border-dashed">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Building2 className="h-3.5 w-3.5" />
                      <span className="text-xs">{p.industry}</span>
                    </div>
                    <p className="font-medium text-foreground">{p.company}</p>
                    <p className="text-xs text-muted-foreground">{p.contact} — {p.role}</p>
                    <Badge variant={scoreVariant(p.score)}>Score {p.score}</Badge>
                  </CardContent>
                </Card>
              ))}
              {col.prospects.length === 0 && (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  Sin prospectos
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
