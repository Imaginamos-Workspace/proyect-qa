import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Protege los endpoints de ingesta máquina-a-máquina (los llama el CI del
 * monorepo, no un usuario). Compara el header `X-Ingest-Key` con la env
 * `INGEST_API_KEY`. No usa JWT de Supabase.
 */
@Injectable()
export class IngestApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INGEST_API_KEY;
    if (!expected) {
      throw new UnauthorizedException('INGEST_API_KEY no configurada en el servidor');
    }
    const request = context.switchToHttp().getRequest();
    const provided = request.headers['x-ingest-key'];
    if (!provided || provided !== expected) {
      throw new UnauthorizedException('X-Ingest-Key inválida o ausente');
    }
    return true;
  }
}
