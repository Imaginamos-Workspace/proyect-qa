import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMarkNotificationsSeen, useSalesNotifications } from '@/hooks/use-sales';
import type { SalesNotification } from '@qa/shared-types';

/** "hace 5 min / hace 3 h / hace 2 d" — suficiente para una campana. */
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

/** Campana de notificaciones del pipeline del vendedor: el TL publicó la
 *  propuesta, negociación, ganada, congelada por tiempo, etapas nuevas
 *  (diseño/desarrollo)… Cada una con CTA directo a la acción que sigue.
 *  Al abrir el panel se marcan como vistas (el badge se apaga). */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data } = useSalesNotifications();
  const markSeen = useMarkNotificationsSeen();

  const notifications = data?.notifications ?? [];
  const unseen = data?.unseenCount ?? 0;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unseen > 0) markSeen.mutate(undefined);
  };

  const go = (n: SalesNotification) => {
    setOpen(false);
    if (n.ctaPath) navigate(n.ctaPath);
  };

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={toggle} title="Notificaciones" className="relative">
        <Bell className="h-5 w-5" />
        {unseen > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unseen > 9 ? '9+' : unseen}
          </span>
        )}
      </Button>

      {open && (
        <>
          {/* Backdrop: clic afuera cierra el panel. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <Card className="absolute right-0 z-50 mt-2 w-[min(92vw,24rem)] shadow-lg">
            <CardContent className="max-h-96 space-y-1 overflow-y-auto p-2">
              {notifications.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Sin notificaciones — te avisamos acá cuando el TL avance o el pipeline cambie de etapa.
                </p>
              ) : (
                notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => go(n)}
                    className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted ${
                      n.seen ? '' : 'bg-primary/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{n.title}</p>
                      {!n.seen && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                    </div>
                    {n.body && <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">{timeAgo(n.createdAt)}</span>
                      {n.ctaLabel && (
                        <span className="flex items-center gap-0.5 text-xs font-medium text-primary">
                          {n.ctaLabel} <ChevronRight className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
