import { Check, ExternalLink, X, Pause } from 'lucide-react';
import { useScrumBoard } from '@/hooks/use-scrum';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Pasos reales de la máquina de estados de ventas (rules/13 §status.md).
// `perdida`/`congelada` son salidas alternativas, no siguen la línea feliz.
const HAPPY_PATH = ['brief', 'propuesta-en-armado', 'propuesta-enviada', 'negociacion', 'ganada'] as const;
const STEP_LABEL: Record<(typeof HAPPY_PATH)[number], string> = {
  brief: 'Brief',
  'propuesta-en-armado': 'Propuesta en armado',
  'propuesta-enviada': 'Propuesta enviada',
  negociacion: 'Negociación',
  ganada: 'Ganada',
};

export function SalesPipelineStepper({ cliente, status }: { cliente: string; status: string }) {
  const isTerminalAlt = status === 'perdida' || status === 'congelada';
  const currentIdx = HAPPY_PATH.indexOf(status as (typeof HAPPY_PATH)[number]);
  // Si el estado no está en la línea feliz (perdida/congelada), marcamos
  // todo hasta "negociación" como completado — es lo último real que pasó.
  const effectiveIdx = currentIdx >= 0 ? currentIdx : HAPPY_PATH.indexOf('negociacion');

  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-3">
          {HAPPY_PATH.map((step, i) => {
            const done = i < effectiveIdx || (i === effectiveIdx && !isTerminalAlt && status === step);
            const isCurrent = !isTerminalAlt && step === status;
            return (
              <div key={step} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
                      done
                        ? 'border-primary bg-primary text-primary-foreground'
                        : isCurrent
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="h-4 w-4" /> : i + 1}
                  </div>
                  <span className={cn('max-w-[90px] text-center text-[11px] leading-tight', done || isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {STEP_LABEL[step]}
                  </span>
                </div>
                {i < HAPPY_PATH.length - 1 && (
                  <div className={cn('mx-1.5 h-0.5 w-6 sm:w-10', i < effectiveIdx ? 'bg-primary' : 'bg-border')} />
                )}
              </div>
            );
          })}

          {isTerminalAlt && (
            <Badge variant={status === 'perdida' ? 'destructive' : 'secondary'} className="ml-2">
              {status === 'perdida' ? <X className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
              {status === 'perdida' ? 'Perdida' : 'Congelada'}
            </Badge>
          )}
        </div>

        {status === 'ganada' && <PostSaleProgress cliente={cliente} />}
      </CardContent>
    </Card>
  );
}

/** Diseño/desarrollo/entrega no tienen un % único calculado en ningún
 *  lado de la plataforma (solo progreso por sprint o por épica, en el
 *  Board) — en vez de inventar un número, enlazamos a la vista real. */
function PostSaleProgress({ cliente }: { cliente: string }) {
  const { data: board } = useScrumBoard(cliente);
  const configured = !!board?.configured;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Badge variant={configured ? 'info' : 'secondary'}>
          {configured ? 'Diseño y desarrollo — en curso' : 'Diseño y desarrollo'}
        </Badge>
        {!configured && (
          <span className="text-xs text-muted-foreground">Todavía no se armó el roadmap de este proyecto en la plataforma.</span>
        )}
      </div>
      {configured && (
        <a
          href={`/board/${cliente}?view=roadmap`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Ver progreso real <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
