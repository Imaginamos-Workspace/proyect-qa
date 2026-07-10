import { useState } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { useAccess } from '@/hooks/use-access';

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isSalesOnly, isLoading } = useAccess();
  const location = useLocation();

  // Espera a resolver el rol antes de decidir — evita mostrarle por un instante
  // otro módulo a un vendedor acotado.
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Cargando…</div>
      </div>
    );
  }
  // Guard duro: un vendedor sin rol interno solo puede estar en /ventas (aunque
  // teclee otra URL). El backend igual valida cada acción por rol.
  if (isSalesOnly && !location.pathname.startsWith('/ventas')) {
    return <Navigate to="/ventas" replace />;
  }

  return (
    <div className="flex h-screen">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-auto bg-background">
          <div className="container mx-auto max-w-7xl p-4 sm:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
