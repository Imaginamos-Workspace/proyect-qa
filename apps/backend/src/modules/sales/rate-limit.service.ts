import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';

const TABLE = 'sales_rate_limits';

/** Rate limiting por-usuario respaldado en DB (sirve en serverless — el estado
 *  no vive en memoria). Cuenta los requests de la ventana; si se alcanza el
 *  límite lanza 429. FAIL-OPEN: si la tabla no existe (migración 027 sin
 *  correr) o la DB falla, NO bloquea al usuario — es defensa anti-abuso, no
 *  un control de seguridad crítico. */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async enforce(actor: string | null, action: string, limit: number, windowMs: number): Promise<void> {
    if (!actor) return; // sin identidad ya lo frena el gate de rol
    const since = new Date(Date.now() - windowMs).toISOString();

    // Sin head:true — con head, supabase-js devuelve count:null (204 sin body).
    // Las filas son pocas (la ventana + el delete de abajo podan) → traerlas
    // es barato y el count viene correcto.
    const { count, error } = await this.supabase
      .from(TABLE)
      .select('id', { count: 'exact' })
      .eq('actor', actor)
      .eq('action', action)
      .gte('created_at', since);
    if (error) {
      this.logger.warn(`Rate limit degradado (${action}): ${error.message}`);
      return; // fail-open
    }

    if ((count ?? 0) >= limit) {
      const mins = Math.max(1, Math.round(windowMs / 60_000));
      throw new HttpException(
        `Alcanzaste el límite (${limit} cada ${mins} min) para esta acción. Espera un momento e intenta de nuevo.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Registra el hit y poda los viejos de esta clave (mantiene la tabla chica).
    await this.supabase.from(TABLE).insert({ actor, action }).then(() => undefined, () => undefined);
    void this.supabase.from(TABLE).delete().eq('actor', actor).eq('action', action).lt('created_at', since).then(
      () => undefined,
      () => undefined,
    );
  }
}
