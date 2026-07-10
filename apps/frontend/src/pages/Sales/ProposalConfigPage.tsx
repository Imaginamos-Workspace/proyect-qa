import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  ArrowLeft,
  Copy,
  Check,
  ExternalLink,
  MessageCircle,
  Mail,
  FileText,
  Info,
  ShieldAlert,
  RefreshCw,
  Eye,
  Clock,
} from 'lucide-react';
import {
  useSalesOpportunity,
  useProposalAccess,
  useProposalMetrics,
  useRegenerateProposal,
  useMarkProposalSent,
} from '@/hooks/use-sales';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

// Sondea cada 10s mientras se regenera, hasta 2 min — tiempo típico del
// workflow de CI (proposal-deploy.yml: password + wrangler deploy).
const REGENERATE_POLL_MS = 10_000;
const REGENERATE_TIMEOUT_MS = 2 * 60_000;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} title={`Copiar ${label}`}>
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'hace 1 día';
  return `hace ${days} días`;
}

export function ProposalConfigPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [regenerating, setRegenerating] = useState(false);
  const { data: opp, isLoading: loadingOpp } = useSalesOpportunity(id ?? null);
  const { data: access, isLoading: loadingAccess } = useProposalAccess(
    id ?? null,
    regenerating ? REGENERATE_POLL_MS : false,
  );
  const { data: metrics } = useProposalMetrics(id ?? null);
  const regenerate = useRegenerateProposal(id ?? '');
  const markSent = useMarkProposalSent(id ?? '');

  // Timeout fijo desde que arrancó el sondeo — OJO: `dataUpdatedAt` NO va en
  // las deps. Bug real que hubo acá: al incluirlo, cada poll exitoso (cada
  // 10s) reiniciaba este efecto (cleanup + timeout nuevo), así que el
  // timeout de 2 min nunca llegaba a dispararse mientras el fetch siguiera
  // funcionando — "Regenerando…" quedaba pegado para siempre si el workflow
  // de CI tardaba más de la cuenta o colgaba.
  useEffect(() => {
    if (!regenerating) return;
    const t = setTimeout(() => setRegenerating(false), REGENERATE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [regenerating]);

  const onRegenerate = () => {
    setRegenerating(true);
    regenerate.mutate();
  };

  if (loadingOpp || !opp) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/ventas/${id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Configuración de la propuesta</h1>
          <p className="text-sm text-muted-foreground">{opp.cliente} / {opp.oportunidad}</p>
        </div>
      </div>

      {loadingAccess || !access ? (
        <Skeleton className="h-64 w-full" />
      ) : !access.generated ? (
        access.tiersReady ? (
          /* El TL ya dejó los 3 tiers — el vendedor publica desde acá: el
             mismo workflow de CI genera la contraseña y sube la propuesta. */
          <Card className="border-primary/40">
            <CardContent className="space-y-3 p-4">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">El TL ya armó las 3 propuestas (media/sólida/económica).</span>{' '}
                Publícala para obtener el link y la contraseña — después la revisas y se la envías al cliente por correo o WhatsApp desde esta misma página.
              </p>
              <Button className="w-full" onClick={onRegenerate} disabled={regenerating}>
                <RefreshCw className={`mr-2 h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
                {regenerating ? 'Publicando… puede tardar 1-2 minutos' : 'Publicar propuesta'}
              </Button>
              {regenerate.isError && (
                <p className="text-xs text-destructive">{(regenerate.error as Error).message}</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex items-start gap-3 p-4">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                La propuesta todavía no fue generada. El TL la arma con <code className="rounded bg-muted px-1">proposals:build</code>{' '}
                y la publica con <code className="rounded bg-muted px-1">proposal:deploy</code> — mientras tanto podés seguir completando el brief.
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <>
          {access.password === null && (
            <Card className="border-destructive/40">
              <CardContent className="flex items-start gap-3 p-4">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  La propuesta está en línea, pero <span className="font-medium text-destructive">sin contraseña activa</span> —
                  no cumple la regla del equipo de que ninguna propuesta se publica sin proteger. Regenerala abajo para cerrar el hueco.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> Acceso
              </p>

              <div className="flex items-center gap-2">
                <a
                  href={access.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 truncate rounded-md border border-input bg-background px-3 py-2 text-sm text-primary hover:underline"
                >
                  {access.url}
                </a>
                <CopyButton value={access.url} label="link" />
                <Button variant="outline" size="icon" asChild title="Abrir propuesta">
                  <a href={access.url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
                </Button>
              </div>

              {access.password && (
                <div className="flex items-center gap-2">
                  <span className="flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm">
                    {access.password}
                  </span>
                  <CopyButton value={access.password} label="contraseña" />
                </div>
              )}

              {access.password && (
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" className="flex-1" asChild>
                    <a
                      href={`https://wa.me/?text=${encodeURIComponent(`Propuesta de ${opp.cliente} — ${opp.oportunidad}\n${access.url}\nContraseña: ${access.password}`)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MessageCircle className="mr-2 h-4 w-4" /> WhatsApp
                    </a>
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" asChild>
                    <a
                      href={`mailto:?subject=${encodeURIComponent(`Propuesta — ${opp.cliente}`)}&body=${encodeURIComponent(`Propuesta de ${opp.cliente} — ${opp.oportunidad}\n${access.url}\nContraseña: ${access.password}`)}`}
                    >
                      <Mail className="mr-2 h-4 w-4" /> Correo
                    </a>
                  </Button>
                </div>
              )}

              {(access.createdAt || access.createdBy) && (
                <p className="text-xs text-muted-foreground">
                  Contraseña creada {access.createdAt ? timeAgo(access.createdAt) : ''}
                  {access.createdBy ? ` por @${access.createdBy}` : ''}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> Métricas de apertura
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-2xl font-semibold text-foreground">{metrics?.totalViews ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">veces abierta</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="flex items-center gap-1 text-sm font-medium text-foreground">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    {metrics?.lastViewedAt ? timeAgo(metrics.lastViewedAt) : 'Nunca'}
                  </p>
                  <p className="text-xs text-muted-foreground">última apertura</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Solo cuenta aperturas donde se ingresó la contraseña correcta.
              </p>
            </CardContent>
          </Card>

          {/* La ENVÍA el vendedor (rules/13): revisada la propuesta y
              compartido el link+contraseña, acá se marca — mueve el proceso a
              propuesta-enviada (status.md línea + bitácora + fila). */}
          {access.password && (
            <Card>
              <CardContent className="space-y-2 p-4">
                {opp.status === 'propuesta-enviada' ? (
                  <p className="flex items-center gap-2 text-sm text-success">
                    <Check className="h-4 w-4" /> Marcada como enviada al cliente — sigue la evaluación (mira las métricas de apertura arriba).
                  </p>
                ) : (
                  <>
                    <Button className="w-full" onClick={() => markSent.mutate()} disabled={markSent.isPending}>
                      <Mail className="mr-2 h-4 w-4" />
                      {markSent.isPending ? 'Marcando…' : 'Ya la envié al cliente — marcar como enviada'}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Primero revísala (link de arriba) y compártela por correo o WhatsApp; este botón pasa el proceso a "Propuesta enviada".
                    </p>
                    {markSent.isError && (
                      <p className="text-xs text-destructive">{(markSent.error as Error).message}</p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="space-y-2 p-4">
              <Button className="w-full" onClick={onRegenerate} disabled={regenerating}>
                <RefreshCw className={`mr-2 h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
                {regenerating ? 'Regenerando… puede tardar 1-2 minutos' : 'Regenerar contraseña'}
              </Button>
              {regenerating && (
                <p className="text-xs text-muted-foreground">
                  El link viejo que ya compartiste con el cliente va a dejar de servir en cuanto termine — vas a necesitar reenviarlo.
                </p>
              )}
              {regenerate.isError && (
                <p className="text-xs text-destructive">{(regenerate.error as Error).message}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Link to={`/ventas/${id}`} className="text-sm text-muted-foreground hover:underline">
        ← Volver a la oportunidad
      </Link>
    </div>
  );
}
