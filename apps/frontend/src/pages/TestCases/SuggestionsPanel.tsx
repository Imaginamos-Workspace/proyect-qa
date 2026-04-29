import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sparkles,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Wand2,
  Trash2,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useSuggestions,
  useExploreSite,
  useDismissSuggestion,
  useConvertSuggestion,
} from '@/hooks/use-suggestions';
import type { AISuggestion } from '@qa/shared-types';

interface Props {
  projectId: string;
}

/**
 * Color palette per detected section. Stable hash so the same section name
 * always gets the same color across reloads.
 */
const SECTION_PALETTE = [
  { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', dot: 'bg-blue-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', dot: 'bg-purple-500' },
  { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' },
  { bg: 'bg-pink-50', border: 'border-pink-200', text: 'text-pink-700', dot: 'bg-pink-500' },
  { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', dot: 'bg-indigo-500' },
  { bg: 'bg-teal-50', border: 'border-teal-200', text: 'text-teal-700', dot: 'bg-teal-500' },
  { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-700', dot: 'bg-rose-500' },
];

function colorFor(section: string) {
  let hash = 0;
  for (let i = 0; i < section.length; i++) hash = (hash * 31 + section.charCodeAt(i)) >>> 0;
  return SECTION_PALETTE[hash % SECTION_PALETTE.length];
}

const PRIORITY_BADGES: Record<string, { variant: 'destructive' | 'warning' | 'secondary'; label: string }> = {
  critical: { variant: 'destructive', label: 'Crítico' },
  high: { variant: 'warning', label: 'Alto' },
  medium: { variant: 'secondary', label: 'Medio' },
  low: { variant: 'secondary', label: 'Bajo' },
};

export function SuggestionsPanel({ projectId }: Props) {
  const { t } = useTranslation();
  const { data: suggestions, isLoading, error } = useSuggestions(projectId);
  const explore = useExploreSite();
  const dismiss = useDismissSuggestion(projectId);
  const convert = useConvertSuggestion(projectId);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Group by section
  const grouped = useMemo(() => {
    const map = new Map<string, AISuggestion[]>();
    for (const s of suggestions || []) {
      const list = map.get(s.section) || [];
      list.push(s);
      map.set(s.section, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [suggestions]);

  const handleExplore = async (reset: boolean) => {
    setFeedback(null);
    try {
      const res = await explore.mutateAsync({
        project_id: projectId,
        reset_pending: reset,
      });
      const total = res.suggestions.length;
      const failed = res.failed_sections.length;
      const skipped = res.skipped_existing;
      let msg = `Generé ${total} sugerencia(s) en ${res.sections.length} sección(es).`;
      if (skipped > 0) msg += ` Salté ${skipped} que ya tenías cubiertas.`;
      if (failed > 0) msg += ` Páginas no escaneadas: ${res.failed_sections.join(', ')}.`;
      setFeedback({ kind: 'ok', msg });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ kind: 'err', msg });
    }
  };

  const handleConvert = async (s: AISuggestion) => {
    setConvertingId(s.id);
    setFeedback(null);
    try {
      await convert.mutateAsync(s.id);
      setFeedback({
        kind: 'ok',
        msg: `"${s.title}" creado como caso de prueba ✅`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ kind: 'err', msg: `No se pudo convertir: ${msg}` });
    } finally {
      setConvertingId(null);
    }
  };

  const handleDismiss = async (id: string) => {
    setFeedback(null);
    try {
      await dismiss.mutateAsync(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ kind: 'err', msg });
    }
  };

  const total = suggestions?.length || 0;

  // Empty: never explored or all converted/dismissed
  if (!isLoading && !error && total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[#7c3aed]/30 bg-gradient-to-br from-[#faf5ff] to-white p-8 text-center">
        <div className="flex justify-center mb-3">
          <div className="rounded-full bg-[#7c3aed]/10 p-3">
            <Lightbulb className="h-7 w-7 text-[#7c3aed]" />
          </div>
        </div>
        <h3 className="text-base font-semibold text-[#1e1b4b] mb-1">
          ¿Por dónde empezar a probar?
        </h3>
        <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
          Deja que la IA explore el sitio configurado y te sugiera escenarios
          concretos por cada sección detectada (login, productos, checkout, etc.).
        </p>
        <Button
          onClick={() => handleExplore(false)}
          disabled={explore.isPending}
          className="gap-2 bg-[#7c3aed] hover:bg-[#6d28d9]"
        >
          {explore.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Explorando sitio…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Explorar sitio con IA
            </>
          )}
        </Button>
        {feedback && (
          <div
            className={`mt-3 inline-flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
              feedback.kind === 'ok'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}
          >
            {feedback.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <span>{feedback.msg}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-[#7c3aed]" />
          <h2 className="text-base font-semibold text-[#1e1b4b]">
            Sugerencias de IA
          </h2>
          {total > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {total}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleExplore(false)}
            disabled={explore.isPending}
            className="gap-1.5 text-xs"
          >
            {explore.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Explorar más
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                confirm(
                  '¿Borrar todas las sugerencias actuales y volver a explorar el sitio desde cero?',
                )
              ) {
                handleExplore(true);
              }
            }}
            disabled={explore.isPending}
            className="gap-1.5 text-xs"
            title="Borra las pendientes y regenera"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Re-explorar
          </Button>
        </div>
      </div>

      {/* Feedback strip */}
      {feedback && (
        <div
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}
        >
          {feedback.kind === 'ok' ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span className="flex-1">{feedback.msg}</span>
          <button onClick={() => setFeedback(null)} className="opacity-70 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Loading initial */}
      {isLoading && (
        <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
          Cargando sugerencias…
        </div>
      )}

      {/* Sections + cards */}
      {grouped.map(([section, items]) => {
        const color = colorFor(section);
        const isCollapsed = collapsed[section] ?? false;
        return (
          <div
            key={section}
            className={`rounded-lg border ${color.border} ${color.bg} overflow-hidden`}
          >
            <button
              onClick={() =>
                setCollapsed((p) => ({ ...p, [section]: !p[section] }))
              }
              className={`w-full flex items-center justify-between px-4 py-2.5 ${color.text} hover:opacity-80 transition-opacity`}
            >
              <div className="flex items-center gap-2">
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
                <div className={`h-2 w-2 rounded-full ${color.dot}`} />
                <span className="text-sm font-semibold">{section}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {items.length}
                </Badge>
              </div>
              <span className="text-[11px] opacity-70 font-mono">
                {items[0]?.scan_url || ''}
              </span>
            </button>

            {!isCollapsed && (
              <div className="px-4 pb-3 pt-1 space-y-2">
                {items.map((s) => {
                  const isConverting = convertingId === s.id && convert.isPending;
                  const prio = PRIORITY_BADGES[s.priority] || PRIORITY_BADGES.medium;
                  return (
                    <div
                      key={s.id}
                      className="rounded-md bg-white border border-input p-3 hover:shadow-sm transition-shadow"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-sm font-semibold text-[#1e1b4b]">
                            {s.title}
                          </h4>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {s.description}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge variant={prio.variant} className="text-[10px]">
                            {prio.label}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {s.test_type}
                          </Badge>
                        </div>
                      </div>

                      <div className="mt-2 grid sm:grid-cols-2 gap-2 text-[11px]">
                        <div className="rounded bg-muted/40 p-2">
                          <p className="font-semibold text-[#1e1b4b] mb-0.5">
                            ✅ Qué probar
                          </p>
                          <p className="text-muted-foreground leading-snug">
                            {s.what_to_test}
                          </p>
                        </div>
                        <div className="rounded bg-muted/40 p-2">
                          <p className="font-semibold text-[#1e1b4b] mb-0.5">
                            🔧 Cómo probarlo
                          </p>
                          <p className="text-muted-foreground leading-snug">
                            {s.how_to_test}
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {s.scan_url}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDismiss(s.id)}
                            disabled={dismiss.isPending}
                            className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive"
                            title="Descartar — no la verás más, pero queda en historial"
                          >
                            <Trash2 className="h-3 w-3" />
                            Descartar
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleConvert(s)}
                            disabled={isConverting || convert.isPending}
                            className="h-7 gap-1 text-xs bg-[#7c3aed] hover:bg-[#6d28d9]"
                          >
                            {isConverting ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Creando…
                              </>
                            ) : (
                              <>
                                <Wand2 className="h-3 w-3" />
                                Convertir en escenario
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
