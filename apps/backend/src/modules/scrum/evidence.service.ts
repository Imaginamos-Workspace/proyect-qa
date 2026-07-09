import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';

// Bucket público donde viven las evidencias. Público a propósito: el link se
// pega en el comentario del issue (repo privado, solo lo ve el equipo) y las
// rutas llevan un UUID no adivinable. Los binarios NO viven en GitHub (no es
// buen almacén de archivos) — GitHub solo guarda el comentario con el link.
const BUCKET = 'qa-evidence';
// Tipos de evidencia aceptados (capturas, video corto, pdf, logs/trazas).
const ALLOWED_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|pdf|txt|log|json|zip|har)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

interface EvidenceFileRef {
  path: string;
  name: string;
}

/**
 * Evidencia de QA sobre un issue del board. Un QA (aunque no tenga silla en
 * GitHub) sube el archivo directo a Supabase Storage vía URL firmada (evita el
 * límite de 4.5MB de body de Vercel) y la plataforma postea un comentario en el
 * issue con el link y la ATRIBUCIÓN del QA real — la escritura a GitHub usa el
 * token de servicio, nunca el PAT personal de nadie.
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);
  private readonly token: string | undefined;
  private readonly owner: string;
  private bucketReady = false;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    config: ConfigService,
  ) {
    this.token = process.env.GITHUB_WRITE_TOKEN || config.get<string>('GITHUB_TOKEN');
    this.owner = config.get<string>('GITHUB_PROJECT_OWNER') ?? 'imaginamos';
  }

  /** Crea el bucket público de evidencias si no existe (idempotente). */
  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    const { error } = await this.supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: '50MB',
    });
    // "already exists" no es error real → seguimos.
    if (error && !/exist/i.test(error.message)) {
      throw new Error(`No se pudo asegurar el bucket de evidencias: ${error.message}`);
    }
    this.bucketReady = true;
  }

  /** URL firmada para que el cliente suba el archivo DIRECTO a la storage
   *  (sin pasar por Vercel). La ruta la elige el servidor (UUID) — el cliente
   *  no puede sobrescribir rutas arbitrarias. */
  async createUploadUrl(slug: string, issueNumber: number, filename: string) {
    const safe = sanitizeFilename(filename);
    if (!ALLOWED_EXT.test(safe)) {
      throw new BadRequestException(
        'Tipo de archivo no permitido. Aceptados: imágenes, video corto, PDF, logs/trazas (.zip/.har/.json/.txt/.log).',
      );
    }
    await this.ensureBucket();
    const path = `${slug}/${issueNumber}/${crypto.randomUUID()}-${safe}`;
    const { data, error } = await this.supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new Error(`No se pudo crear la URL de subida: ${error?.message ?? 'sin datos'}`);
    return { bucket: BUCKET, path: data.path, token: data.token, name: safe };
  }

  /** Postea un comentario en el issue del cliente con el texto + las evidencias
   *  (links a la storage) y la atribución del QA real. Escribe con el token de
   *  servicio (Issues:write). */
  async postEvidenceComment(
    slug: string,
    issueNumber: number,
    input: { comment: string; files: EvidenceFileRef[]; actorName: string },
  ): Promise<{ url: string }> {
    if (!this.token) throw new Error('GITHUB_WRITE_TOKEN no configurado en el servidor.');
    if (!input.comment.trim() && input.files.length === 0) {
      throw new BadRequestException('Nada que publicar: escribí un comentario o adjuntá al menos una evidencia.');
    }

    const body = this.composeBody(input);
    const url = `https://api.github.com/repos/${this.owner}/qa-${slug}/issues/${issueNumber}/comments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'qa-portal-evidence',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403 || res.status === 404) {
      throw new UnauthorizedException(
        'El token del portal no puede comentar en el repo del cliente (Issues:write). Revisá GITHUB_WRITE_TOKEN.',
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub rechazó el comentario (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { html_url: string };
    return { url: json.html_url };
  }

  /** Cuerpo del comentario: texto + evidencias (imágenes embebidas, resto como
   *  link) + atribución del QA real (la API usa el token de servicio, así que
   *  esta línea es la ÚNICA fuente de "quién lo hizo"). */
  private composeBody(input: { comment: string; files: EvidenceFileRef[]; actorName: string }): string {
    const parts: string[] = [];
    if (input.comment.trim()) parts.push(input.comment.trim());
    if (input.files.length) {
      const items = input.files.map((f) => {
        const publicUrl = this.supabase.storage.from(BUCKET).getPublicUrl(f.path).data.publicUrl;
        return IMAGE_EXT.test(f.name) ? `![${f.name}](${publicUrl})` : `- [${f.name}](${publicUrl})`;
      });
      parts.push(`**Evidencia adjunta:**\n\n${items.join('\n')}`);
    }
    parts.push(`\n> Cargado desde la plataforma QA por ${input.actorName}.`);
    return parts.join('\n\n');
  }
}

/** Nombre de archivo seguro para una ruta de storage (sin path traversal). */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo';
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'archivo';
}
