import { type ReactNode } from 'react';
import { Check, ExternalLink, X, Pause, Circle, AlertTriangle, Loader2 } from 'lucide-react';
import { useScrumBoard } from '@/hooks/use-scrum';
import { useClient } from '@/hooks/use-dashboard';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Máquina de estados real de ventas (rules/13 §status.md).
const SALES_PATH = ['brief', 'propuesta-en-armado', 'propuesta-enviada', 'negociacion', 'ganada'] as const;
const SALES_DESC: Record<(typeof SALES_PATH)[number], string> = {
  brief: 'El vendedor arma el brief con el cliente.',
  'propuesta-en-armado': 'El TL arma las 3 propuestas (media/sólida/económica).',
  'propuesta-enviada': 'El cliente evalúa la propuesta enviada.',
  negociacion: 'Ajustes de alcance, tiempos o precio antes de cerrar.',
  ganada: 'Venta cerrada. Se dispara el traspaso a QA y Diseño (rules/13).',
};

// Mismo criterio "terminada" que usa el resto de la plataforma
// (board-roadmap.tsx) — para calcular el % real de desarrollo.
const isDone = (s: string | null) => !!s && /\b(done|hecho|listo|complet|cerrad|finaliz|resuel)/i.test(s);

type StepStatus = 'done' | 'current' | 'pending';

interface TimelineStep {
  key: string;
  title: string;
  description: string;
  status: StepStatus;
  meta?: ReactNode;
}

export function SalesPipelineStepper({ cliente, status }: { cliente: string; status: string }) {
  const ganada = status === 'ganada';
  // Solo pedimos board/cliente si ya ganó — antes de eso no hay nada que traspasar.
  const { data: board } = useScrumBoard(ganada ? cliente : '');
  const { data: clientDetail } = useClient(ganada ? cliente : '');

  const isTerminalAlt = status === 'perdida' || status === 'congelada';
  const salesIdx = SALES_PATH.indexOf(status as (typeof SALES_PATH)[number]);
  // `status` es texto libre en la base (rules/13 puede agregar/renombrar
  // estados) — si no lo reconocemos y tampoco es perdida/congelada, NO
  // adivinamos una posición (antes caía en "negociación" en silencio, una
  // etapa incorrecta mostrada con total confianza). Mostramos el aviso de
  // abajo y dejamos los pasos sin ninguno marcado como actual.
  const isUnknownStatus = salesIdx < 0 && !isTerminalAlt;
  const effectiveSalesIdx = salesIdx >= 0 ? salesIdx : -1;

  const salesSteps: TimelineStep[] = SALES_PATH.map((step, i) => ({
    key: step,
    title: SALES_STEP_LABEL[step],
    description: SALES_DESC[step],
    status:
      effectiveSalesIdx < 0
        ? 'pending'
        : i < effectiveSalesIdx || (i === effectiveSalesIdx && !isTerminalAlt)
          ? (i === effectiveSalesIdx ? 'current' : 'done')
          : 'pending',
  }));

  const postSaleSteps: TimelineStep[] = [];
  if (ganada) {
    const configured = !!board?.configured;
    const designsUrl = clientDetail?.designs_url ?? null;

    const allCards = board?.columns.flatMap((c) => c.cards) ?? [];
    const relevant = allCards.filter((c) => c.type === 'story' || c.type === 'task' || c.type === 'bug');
    const doneCount = relevant.filter((c) => isDone(c.status)).length;
    const devPct = relevant.length ? Math.round((doneCount / relevant.length) * 100) : 0;

    postSaleSteps.push(
      {
        key: 'traspaso',
        title: 'Traspaso a QA y Diseño',
        description: 'Se crean el repo, el board y los issues iniciales para QA y Diseño.',
        status: configured ? 'done' : 'current',
      },
      {
        key: 'diseno',
        title: 'Diseño',
        description: designsUrl ? 'Hay diseños publicados para este cliente.' : 'Todavía no hay diseños publicados.',
        status: designsUrl ? 'done' : configured ? 'current' : 'pending',
        meta: designsUrl && (
          <a href={designsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Ver diseños <ExternalLink className="h-3 w-3" />
          </a>
        ),
      },
      {
        key: 'roadmap',
        title: 'Roadmap y plan de sprints',
        description: configured ? 'El PM armó épicas, historias y sprints en el board.' : 'Todavía no se armó el roadmap de este proyecto.',
        status: configured ? 'done' : 'pending',
        meta: configured && (
          <a href={`/board/${cliente}?view=roadmap`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Ver roadmap <ExternalLink className="h-3 w-3" />
          </a>
        ),
      },
      {
        key: 'desarrollo',
        title: 'Desarrollo',
        description: configured ? `${devPct}% de las historias/tareas están Done (${doneCount}/${relevant.length}).` : 'Arranca cuando el roadmap esté armado.',
        status: !configured ? 'pending' : devPct >= 100 ? 'done' : 'current',
        meta: configured && (
          <a href={`/board/${cliente}?view=sprint`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Ver sprints <ExternalLink className="h-3 w-3" />
          </a>
        ),
      },
      {
        key: 'entrega',
        title: 'Entrega',
        description: configured && devPct >= 100 ? 'Todo lo del roadmap está Done.' : 'Se marca sola cuando el desarrollo llega al 100%.',
        status: configured && devPct >= 100 ? 'done' : 'pending',
      },
    );
  }

  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        {isUnknownStatus && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-xs text-muted-foreground">
              Estado <span className="font-mono font-medium text-foreground">"{status}"</span> no
              reconocido — no podemos ubicarlo con certeza en el pipeline de abajo.
            </p>
          </div>
        )}
        <ol className="space-y-0">
          {salesSteps.map((step, i) => (
            <TimelineItem key={step.key} step={step} isLast={i === salesSteps.length - 1 && postSaleSteps.length === 0 && !isTerminalAlt} />
          ))}
          {isTerminalAlt && (
            <li className="flex items-start gap-3 pb-1">
              <div className="flex flex-col items-center">
                <div className={cn('flex h-6 w-6 items-center justify-center rounded-full', status === 'perdida' ? 'bg-destructive text-destructive-foreground' : 'bg-muted text-muted-foreground')}>
                  {status === 'perdida' ? <X className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </div>
              </div>
              <div className="pt-0.5">
                <Badge variant={status === 'perdida' ? 'destructive' : 'secondary'}>
                  {status === 'perdida' ? 'Perdida' : 'Congelada'}
                </Badge>
              </div>
            </li>
          )}
          {postSaleSteps.map((step, i) => (
            <TimelineItem key={step.key} step={step} isLast={i === postSaleSteps.length - 1} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

const SALES_STEP_LABEL: Record<(typeof SALES_PATH)[number], string> = {
  brief: 'Brief',
  'propuesta-en-armado': 'Propuesta en armado',
  'propuesta-enviada': 'Propuesta enviada',
  negociacion: 'Negociación',
  ganada: 'Ganada',
};

/** Versión COMPACTA del pipeline para el header de la conversación: la fase
 *  actual con loader visible + puntos de las fases hechas/restantes, en una
 *  sola línea — el vendedor ve cuánto proceso queda sin salir del chat.
 *  Misma máquina de estados que el stepper grande (una sola fuente). */
export function SalesPipelineMini({ status }: { status: string }) {
  const isTerminalAlt = status === 'perdida' || status === 'congelada';
  const idx = SALES_PATH.indexOf(status as (typeof SALES_PATH)[number]);
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {SALES_PATH.map((step, i) => {
        const state: StepStatus =
          isTerminalAlt || idx < 0 ? 'pending' : i < idx ? 'done' : i === idx ? 'current' : 'pending';
        return (
          <div key={step} className="flex items-center gap-1.5">
            {i > 0 && <div className={cn('h-px w-3 sm:w-5', state === 'pending' ? 'bg-border' : 'bg-primary/60')} />}
            {state === 'current' ? (
              <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Loader2 className="h-3 w-3 animate-spin" /> {SALES_STEP_LABEL[step]}
              </span>
            ) : (
              <span
                title={SALES_STEP_LABEL[step]}
                className={cn('h-2 w-2 shrink-0 rounded-full', state === 'done' ? 'bg-primary' : 'bg-muted-foreground/30')}
              />
            )}
          </div>
        );
      })}
      {isTerminalAlt ? (
        <Badge variant={status === 'perdida' ? 'destructive' : 'secondary'} className="ml-1">
          {status === 'perdida' ? 'Perdida' : 'Congelada'}
        </Badge>
      ) : idx >= 0 ? (
        <span className="ml-auto whitespace-nowrap pl-2 text-[11px] text-muted-foreground">
          Fase {idx + 1} de {SALES_PATH.length}
        </span>
      ) : (
        // Etapa nueva del monorepo que no reconocemos — se muestra tal cual.
        <Badge variant="secondary" className="ml-1">{status}</Badge>
      )}
    </div>
  );
}

function TimelineItem({ step, isLast }: { step: TimelineStep; isLast: boolean }) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
            step.status === 'done'
              ? 'bg-primary text-primary-foreground'
              : step.status === 'current'
                ? 'bg-primary/15 text-primary ring-2 ring-primary'
                : 'bg-muted text-muted-foreground/60',
          )}
        >
          {step.status === 'done' ? <Check className="h-3.5 w-3.5" /> : step.status === 'current' ? <Circle className="h-2 w-2 fill-current" /> : null}
        </div>
        {!isLast && <div className={cn('w-0.5 flex-1 my-0.5', step.status === 'done' ? 'bg-primary' : 'bg-border')} style={{ minHeight: 24 }} />}
      </div>
      <div className={cn('flex-1 pb-4', isLast && 'pb-0.5')}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className={cn('text-sm font-medium', step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground')}>
            {step.title}
          </p>
          {step.meta}
        </div>
        <p className="text-xs text-muted-foreground">{step.description}</p>
      </div>
    </li>
  );
}
