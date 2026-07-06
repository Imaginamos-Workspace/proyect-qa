import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Building2, Sparkles, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useCreateOpportunity } from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { api } from '@/lib/api';

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

// Mismo criterio kebab-case que exige CreateOpportunityDto en el backend.
function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function ProspectsKanban() {
  const navigate = useNavigate();
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const createOpportunity = useCreateOpportunity();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Convierte un prospecto del mockup en una oportunidad real y arranca el
  // chat con lo que "ya sabemos" de Apollo — el vendedor no repite a mano lo
  // que el prospecto ya trae. Reusa el mismo endpoint de mensajes que usa el
  // chat normal (el LLM extrae esto al draft igual que cualquier otro texto).
  const onProspectClick = async (p: MockProspect) => {
    if (!isVendedor) return;
    const key = p.company;
    setErrorMsg(null);
    setLoadingKey(key);
    try {
      const cliente = slugify(p.company);
      const oportunidad = 'contacto-inicial';
      const opp = await createOpportunity.mutateAsync({ cliente, oportunidad });
      const seedMessage =
        `Prospecto detectado por Apollo.io — ${p.company} (${p.industry}). ` +
        `Contacto: ${p.contact}, ${p.role}. Score de calificación: ${p.score}. ` +
        `Ayúdame a armar el brief con esto como punto de partida.`;
      // Timeout largo (55s), igual que el chat normal: este primer mensaje
      // dispara la cascada del LLM (Gemini→Groq→DeepSeek) y puede tardar más
      // que el default de 20s de api.post — sin esto abortaba a los 20s y la
      // conversación quedaba vacía al abrir /ventas/:id (bug reportado).
      await api.post(`/sales/opportunities/${opp.id}/messages`, { content: seedMessage }, 55_000);
      navigate(`/ventas/${opp.id}`);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `No se pudo iniciar la conversación con ${p.company}: ${err.message}`
          : `No se pudo iniciar la conversación con ${p.company}.`,
      );
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-4 py-3">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Vista previa — Fase 2.</span>{' '}
          Los prospectos de acá van a venir automáticamente de Apollo.io. Por ahora son datos de
          ejemplo{isVendedor ? ' — tocá uno para arrancar la conversación con el agente, ya con estos datos precargados.' : '.'}
        </p>
      </div>

      {errorMsg && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorMsg}
        </p>
      )}

      <div className="flex gap-4 overflow-x-auto pb-2">
        {MOCK_COLUMNS.map((col) => (
          <div key={col.key} className="w-72 shrink-0">
            <div className="mb-3 flex items-center justify-between px-1">
              <p className="text-sm font-semibold text-foreground">{col.label}</p>
              <Badge variant="secondary">{col.prospects.length}</Badge>
            </div>
            <div className="space-y-3">
              {col.prospects.map((p, i) => {
                const isLoading = loadingKey === p.company;
                return (
                  <Card
                    key={i}
                    role={isVendedor ? 'button' : undefined}
                    tabIndex={isVendedor ? 0 : undefined}
                    onClick={() => !loadingKey && onProspectClick(p)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !loadingKey) onProspectClick(p); }}
                    className={`border-dashed transition-colors ${
                      !isVendedor
                        ? 'border-dashed'
                        : loadingKey
                          ? 'cursor-default opacity-70'
                          : 'cursor-pointer hover:border-primary hover:bg-primary/5'
                    }`}
                  >
                    <CardContent className="space-y-2 p-4">
                      <div className="flex items-center justify-between gap-2 text-muted-foreground">
                        <span className="flex items-center gap-2 text-xs">
                          <Building2 className="h-3.5 w-3.5" /> {p.industry}
                        </span>
                        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                      </div>
                      <p className="font-medium text-foreground">{p.company}</p>
                      <p className="text-xs text-muted-foreground">{p.contact} — {p.role}</p>
                      <Badge variant={scoreVariant(p.score)}>Score {p.score}</Badge>
                    </CardContent>
                  </Card>
                );
              })}
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
