import { cn } from '@/lib/utils';

/** Placeholder de carga. Usa el token `muted` → respeta el dark mode. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/** Grilla de StatCards en carga (misma altura que el StatCard real). */
export function StatCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-4">
        <Skeleton className="h-12 w-12 rounded-md" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-16" />
        </div>
      </div>
    </div>
  );
}
