import { useScrumMe } from './use-scrum';

// Roles internos (QA / desarrollo / gestión) que dan acceso a TODA la
// plataforma. Un usuario con cualquiera de estos ve todos los módulos.
const FULL_ACCESS_ROLES = ['qa', 'tl', 'pm', 'dev', 'devops', 'designer'];

/**
 * Acceso por rol. Un `vendedor` que NO tiene ningún rol interno queda acotado
 * al módulo de Ventas (ve y navega solo eso). Los roles salen de team.json del
 * monorepo vía /scrum/me. Si los roles aún no cargaron, `isSalesOnly` es false
 * para no ocultar nada por error mientras resuelve.
 */
export function useAccess() {
  const { data: me, isLoading } = useScrumMe();
  const roles = me?.roles ?? [];
  const hasFullAccess = roles.some((r) => FULL_ACCESS_ROLES.includes(r));
  const isSalesOnly = !isLoading && roles.includes('vendedor') && !hasFullAccess;
  return { roles, isSalesOnly, hasFullAccess, isLoading };
}
