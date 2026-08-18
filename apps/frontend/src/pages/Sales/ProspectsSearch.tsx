import { useState } from 'react';
import { Bookmark, BookmarkCheck, Building2, CalendarClock, ExternalLink, KanbanSquare, KeyRound, Linkedin, Loader2, Mail, MapPin, Search, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useCreateSavedSearch,
  useDeleteSavedSearch,
  useProspectsStatus,
  useSaveProspect,
  useSavedProspects,
  useSavedSearches,
  useSearchProspects,
} from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { ProspectsPipeline } from './ProspectsPipeline';

// "CEO, Gerente de operaciones" → ['CEO', 'Gerente de operaciones']
function splitList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Guía cuando falta la API key — el flujo queda listo y esto es lo único
 *  pendiente de configuración manual. */
function ApolloSetupCard() {
  return (
    <Card className="border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20">
      <CardContent className="space-y-3 p-6">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-4 w-4 text-amber-600" /> Falta la API key de Apollo.io
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Copia tu key desde Apollo.io → Settings → Integrations → API.</li>
          <li>
            En Vercel, proyecto del <span className="font-medium">backend</span> → Settings → Environment
            Variables → agrega <code className="rounded bg-muted px-1">APOLLO_API_KEY</code> y redeploya.
          </li>
          <li>
            En local va en <code className="rounded bg-muted px-1">apps/backend/.env</code>.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          La key vive solo en el backend — nunca llega al navegador. Apenas esté configurada, este tab
          muestra el buscador automáticamente.
        </p>
      </CardContent>
    </Card>
  );
}

export function ProspectsSearch() {
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const { data: status, isLoading: statusLoading } = useProspectsStatus();
  const search = useSearchProspects();
  const saveProspect = useSaveProspect();
  const { data: saved } = useSavedProspects();
  const { data: savedSearches } = useSavedSearches();
  const createSavedSearch = useCreateSavedSearch();
  const deleteSavedSearch = useDeleteSavedSearch();

  // Arranca en "Buscar en Apollo" — es la primera pestaña, y su contenido es el
  // que se ve al entrar. "Mis clientes" queda a un clic.
  const [view, setView] = useState<'buscar' | 'pipeline'>('buscar');
  const [keywords, setKeywords] = useState('');
  const [titles, setTitles] = useState('');
  const [locations, setLocations] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const runSearch = (page = 1) => {
    search.mutate({
      keywords: keywords.trim() || undefined,
      titles: splitList(titles),
      locations: splitList(locations),
      page,
    });
  };

  const guardarBusquedaSemanal = () => {
    createSavedSearch.mutate({
      keywords: keywords.trim() || undefined,
      titles: splitList(titles),
      locations: splitList(locations),
    });
  };

  if (statusLoading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!status?.configured) {
    return <ApolloSetupCard />;
  }

  const result = search.data;
  // Idempotencia visible: guardados según el backend (savedApolloIds de la
  // búsqueda) + los del pipeline ya cargado (cubre lo recién guardado).
  const savedIds = new Set([...(result?.savedApolloIds ?? []), ...(saved ?? []).map((p) => p.apolloId)]);
  const pipelineCount = (saved ?? []).filter((p) => p.estado !== 'descartado' && p.estado !== 'convertido').length;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button variant={view === 'buscar' ? 'default' : 'outline'} size="sm" onClick={() => setView('buscar')}>
          <Search className="mr-2 h-4 w-4" /> Buscar en Apollo
        </Button>
        <Button variant={view === 'pipeline' ? 'default' : 'outline'} size="sm" onClick={() => setView('pipeline')}>
          <KanbanSquare className="mr-2 h-4 w-4" /> Mis clientes{pipelineCount ? ` (${pipelineCount})` : ''}
        </Button>
      </div>

      {view === 'pipeline' ? (
        <ProspectsPipeline />
      ) : (
        <>
          <Card>
            <CardContent className="p-6">
              <form
                onSubmit={(e) => { e.preventDefault(); runSearch(1); }}
                className="flex flex-wrap items-end gap-3"
              >
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Texto libre</label>
                  <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="ecommerce, logística, retail…" />
                </div>
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Cargos (separados por coma)</label>
                  <Input value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="CEO, Gerente de operaciones" />
                </div>
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Ubicación (separadas por coma)</label>
                  <Input value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="Bogotá, Colombia" />
                </div>
                <Button type="submit" disabled={!isVendedor || search.isPending}>
                  {search.isPending
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Buscando…</>
                    : <><Search className="mr-2 h-4 w-4" /> Buscar</>}
                </Button>
                <Button type="button" variant="outline" disabled={!isVendedor || createSavedSearch.isPending} onClick={guardarBusquedaSemanal} title="El cron la ejecuta cada lunes y guarda los prospectos nuevos en tu pipeline (sin duplicar)">
                  <CalendarClock className="mr-2 h-4 w-4" /> Correr semanalmente
                </Button>
              </form>
              {!isVendedor && (
                <p className="mt-2 text-xs text-muted-foreground">Solo el rol vendedor puede buscar (consume cuota de Apollo).</p>
              )}
              {search.isError && (
                <p className="mt-2 text-sm text-destructive">{(search.error as Error).message}</p>
              )}
              {createSavedSearch.isSuccess && (
                <p className="mt-2 text-xs text-primary">Búsqueda guardada — corre cada lunes y llena tu pipeline sin duplicar.</p>
              )}
              {!!savedSearches?.length && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {savedSearches.map((s) => (
                    <Badge key={s.id} variant="secondary" className="gap-1.5">
                      <CalendarClock className="h-3 w-3" />
                      {[s.keywords, s.titles.join('/'), s.locations.join('/')].filter(Boolean).join(' · ') || '(sin filtros)'}
                      {s.lastRunAt ? ` · corrió ${new Date(s.lastRunAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}` : ' · aún no corre'}
                      <button type="button" title="Eliminar búsqueda semanal" onClick={() => deleteSavedSearch.mutate(s.id)}>
                        <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {search.isPending && (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 w-full" />)}
            </div>
          )}

          {result && !search.isPending && (
            <>
              <p className="text-xs text-muted-foreground">
                {result.totalEntries.toLocaleString()} prospectos — página {result.page} de {result.totalPages}.
                Guarda los que te interesen: pasan a tu pipeline para contactarlos (guardar desbloquea el dato completo — 1 crédito).
              </p>
              {result.prospects.length === 0 ? (
                <Card>
                  <CardContent className="p-10 text-center text-sm text-muted-foreground">
                    Sin resultados con esos filtros — prueba con menos criterios.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {result.prospects.map((p) => {
                    const isSaved = savedIds.has(p.id);
                    const isSaving = savingId === p.id && saveProspect.isPending;
                    return (
                      <Card key={p.id}>
                        <CardContent className="space-y-2 p-4">
                          <div className="flex items-center justify-between gap-2 text-muted-foreground">
                            <span className="flex items-center gap-2 text-xs">
                              <Building2 className="h-3.5 w-3.5" /> {p.industry ?? 'Sin industria'}
                            </span>
                          </div>
                          <p className="font-medium text-foreground">{p.company ?? p.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {p.name}{p.title ? ` — ${p.title}` : ''}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {p.location && (
                              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {p.location}</span>
                            )}
                            {p.email && (
                              <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {p.email}</span>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap gap-2">
                              {p.linkedinUrl && (
                                <a href={p.linkedinUrl} target="_blank" rel="noreferrer">
                                  <Badge variant="secondary" className="gap-1"><Linkedin className="h-3 w-3" /> LinkedIn</Badge>
                                </a>
                              )}
                              {p.companyWebsite && (
                                <a href={p.companyWebsite} target="_blank" rel="noreferrer">
                                  <Badge variant="secondary" className="gap-1"><ExternalLink className="h-3 w-3" /> Sitio</Badge>
                                </a>
                              )}
                            </div>
                            <Button
                              size="sm"
                              variant={isSaved ? 'secondary' : 'default'}
                              disabled={!isVendedor || isSaved || isSaving}
                              onClick={() => { setSavingId(p.id); saveProspect.mutate(p); }}
                            >
                              {isSaving
                                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Guardando…</>
                                : isSaved
                                  ? <><BookmarkCheck className="mr-1.5 h-3.5 w-3.5" /> Guardado</>
                                  : <><Bookmark className="mr-1.5 h-3.5 w-3.5" /> Guardar</>}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
              {result.totalPages > 1 && (
                <div className="flex items-center justify-center gap-3">
                  <Button variant="outline" size="sm" disabled={result.page <= 1 || search.isPending} onClick={() => runSearch(result.page - 1)}>
                    Anterior
                  </Button>
                  <span className="text-xs text-muted-foreground">{result.page} / {result.totalPages}</span>
                  <Button variant="outline" size="sm" disabled={result.page >= result.totalPages || search.isPending} onClick={() => runSearch(result.page + 1)}>
                    Siguiente
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
