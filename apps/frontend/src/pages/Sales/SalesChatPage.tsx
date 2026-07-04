import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { ArrowLeft, Send, RefreshCw, CheckCircle2, ExternalLink } from 'lucide-react';
import {
  useSalesOpportunity,
  useSendSalesMessage,
  useSyncBrief,
  useHandoffToTl,
} from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const SECTIONS: { key: string; label: string }[] = [
  { key: 'cliente', label: 'Cliente' },
  { key: 'problema', label: 'Problema' },
  { key: 'outcomes', label: 'Outcomes' },
  { key: 'usuariosYFuncionalidades', label: 'Usuarios y funcionalidades' },
  { key: 'limites', label: 'Límites' },
  { key: 'integraciones', label: 'Integraciones' },
  { key: 'riesgos', label: 'Riesgos' },
  { key: 'sensacionVendedor', label: 'Sensación del vendedor' },
];

export function SalesChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');

  const { data: opp, isLoading } = useSalesOpportunity(id ?? null);
  const sendMessage = useSendSalesMessage(id ?? '');
  const syncBrief = useSyncBrief(id ?? '');
  const handoff = useHandoffToTl(id ?? '');

  const [draftMessage, setDraftMessage] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftMessage.trim()) return;
    sendMessage.mutate(draftMessage, { onSuccess: () => setDraftMessage('') });
  };

  if (isLoading || !opp) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const draft = opp.draft ?? {};
  const asunciones = draft.asunciones ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/ventas')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{opp.oportunidad}</h1>
            <p className="text-sm text-muted-foreground">{opp.cliente}</p>
          </div>
        </div>
        <Badge variant={opp.status === 'brief' ? 'secondary' : 'success'}>
          {opp.status === 'brief' ? 'Brief en armado' : 'Con el TL'}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* Chat */}
        <Card className="flex h-[70vh] flex-col">
          <CardContent className="flex flex-1 flex-col overflow-hidden p-4">
            <div className="flex-1 space-y-3 overflow-y-auto pr-1">
              {opp.messages.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Contame del cliente y del problema que quiere resolver — o pegá la transcripción
                  de la reunión si ya la tenés, y extraigo lo que pueda de ahí.
                </p>
              )}
              {opp.messages.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                    m.role === 'vendor' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted text-foreground',
                  )}
                >
                  {m.content}
                </div>
              ))}
              {sendMessage.isPending && (
                <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  Pensando…
                </div>
              )}
            </div>

            {isVendedor && (
              <form onSubmit={submit} className="mt-3 flex gap-2">
                <Textarea
                  value={draftMessage}
                  onChange={(e) => setDraftMessage(e.target.value)}
                  placeholder="Escribí acá, o pegá la transcripción de la reunión…"
                  className="min-h-[60px]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
                  }}
                />
                <Button type="submit" disabled={sendMessage.isPending || !draftMessage.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            )}
            {sendMessage.isError && (
              <p className="mt-2 text-sm text-destructive">{(sendMessage.error as Error).message}</p>
            )}
          </CardContent>
        </Card>

        {/* Draft preview + acciones */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Draft del brief
              </p>
              {SECTIONS.map((s) => (
                <div key={s.key}>
                  <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
                  <p className="text-sm text-foreground">
                    {(draft as Record<string, string | undefined>)[s.key] || <span className="text-muted-foreground">—</span>}
                  </p>
                </div>
              ))}
              <div>
                <p className="text-xs font-medium text-muted-foreground">Asunciones</p>
                {asunciones.length === 0 ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1 text-sm text-foreground">
                    {asunciones.map((a, i) => (
                      <li key={i}>
                        {a.texto} — <span className="text-muted-foreground">{a.impactoSiFalla}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {isVendedor && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => syncBrief.mutate()}
                  disabled={syncBrief.isPending}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {syncBrief.isPending ? 'Sincronizando…' : 'Sincronizar brief.md'}
                </Button>
                {syncBrief.data && (
                  <a
                    href={syncBrief.data.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> Ver en GitHub
                  </a>
                )}
                <Button
                  className="w-full"
                  onClick={() => handoff.mutate()}
                  disabled={handoff.isPending || opp.status !== 'brief'}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {opp.status !== 'brief' ? 'Ya está con el TL' : handoff.isPending ? 'Pasando…' : 'Pasar a TL'}
                </Button>
                {(syncBrief.isError || handoff.isError) && (
                  <p className="text-xs text-destructive">
                    {((syncBrief.error ?? handoff.error) as Error).message}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Link to="/ventas" className="text-sm text-muted-foreground hover:underline">
        ← Volver a oportunidades
      </Link>
    </div>
  );
}
