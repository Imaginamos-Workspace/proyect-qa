import { type LucideIcon, TrendingUp, TrendingDown } from 'lucide-react';
import { Card, CardContent } from './card';
import { cn } from '@/lib/utils';

export type StatTone = 'primary' | 'success' | 'warning' | 'destructive' | 'info';

// Clases por tono usando tokens semánticos (respetan el dark mode).
const TONES: Record<StatTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  info: 'bg-info/10 text-info',
};

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  /** Tono semántico (preferido). Pinta el icono con tokens del tema. */
  tone?: StatTone;
  /** Override legacy con color literal — evitar; rompe el dark mode. */
  iconBg?: string;
  iconColor?: string;
  change?: { value: number; type: 'up' | 'down' };
  subtitle?: string;
}

export function StatCard({
  title,
  value,
  icon: Icon,
  tone = 'primary',
  iconBg,
  iconColor,
  change,
  subtitle,
}: StatCardProps) {
  const legacy = iconBg || iconColor;
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-md',
            !legacy && TONES[tone],
          )}
          style={legacy ? { backgroundColor: iconBg } : undefined}
        >
          <Icon className="h-5 w-5" style={legacy ? { color: iconColor } : undefined} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </p>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-semibold text-foreground">{value}</p>
            {change && (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 text-xs font-medium',
                  change.type === 'up' ? 'text-success' : 'text-destructive',
                )}
              >
                {change.type === 'up' ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {change.value}%
              </span>
            )}
          </div>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
