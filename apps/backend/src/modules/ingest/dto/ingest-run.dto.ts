import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class CoverageModuleDto {
  @IsString() name: string;
  @IsInt() @Min(0) total: number;
  @IsInt() @Min(0) passed: number;
}

class StoryMapEntryDto {
  @IsInt() @Min(1) story: number;
  @IsInt() @Min(0) total: number;
  @IsInt() @Min(0) passed: number;
  @IsInt() @Min(0) failed: number;
}

// Universo de regresión anidado en una corrida (coverage:universe del monorepo).
// Misma forma que IngestUniverseDto pero SIN datos de cliente: la corrida ya los trae.
// Permite que cada run refresque el % del widget en un solo upsert (ver ingestRun).
class RunUniverseDto {
  @IsInt() @Min(0) total_modules: number;
  @IsInt() @Min(0) covered_modules: number;
  @IsInt() @Min(0) pct: number;
  @IsInt() @Min(0) total_stories: number;
  @IsInt() @Min(0) automated_stories: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => UniverseModuleDto)
  modules: UniverseModuleDto[];
}

class RunCoverageDto {
  @IsInt() @Min(0) specs_total: number;
  @IsInt() @Min(0) specs_covered: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => CoverageModuleDto)
  modules: CoverageModuleDto[];
  // Trazabilidad test→historia (board): qué historias tienen pruebas y cómo van.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => StoryMapEntryDto)
  story_map?: StoryMapEntryDto[];
  // Títulos de pruebas SIN historia ligada (panel de mapeo pendiente).
  @IsOptional() @IsArray() @IsString({ each: true }) unmapped_tests?: string[];
  // Universo de cobertura recalculado en esta corrida (auto-sync del % de regresión).
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RunUniverseDto)
  universe?: RunUniverseDto;
}

class IngestTestDto {
  @IsOptional() @IsString() test_id?: string;
  @IsString() title: string;
  @IsOptional() @IsString() file?: string;
  @IsIn(['passed', 'failed', 'skipped', 'flaky']) status: string;
  @IsOptional() @IsString() spec?: string;
  @IsOptional() @IsInt() story?: number;
}

export class IngestRunDto {
  @IsString() client_slug: string;
  @IsOptional() @IsString() client_name?: string;
  @IsOptional() @IsString() reports_url?: string;
  @IsOptional() @IsString() designs_url?: string;
  @IsOptional() @IsString() suite?: string;
  @IsOptional() @IsString() commit_sha?: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsString() actor_login?: string;
  @IsOptional() @IsString() status?: string;

  @IsInt() @Min(0) total: number;
  @IsInt() @Min(0) passed: number;
  @IsInt() @Min(0) failed: number;
  @IsInt() @Min(0) skipped: number;
  @IsOptional() @IsInt() @Min(0) flaky?: number;
  @IsOptional() @IsInt() @Min(0) duration_ms?: number;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => RunCoverageDto)
  coverage?: RunCoverageDto;

  @IsOptional() @IsString() report_url?: string;
  @IsOptional() @IsString() gh_run_url?: string;
  @IsOptional() @IsString() started_at?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IngestTestDto)
  tests?: IngestTestDto[];
}

/** Un módulo del UNIVERSO de cobertura (denominador del % real de regresión). */
class UniverseModuleDto {
  @IsString() name: string;
  @IsOptional() @IsArray() @IsString({ each: true }) epics?: string[];
  @IsInt() @Min(0) stories_total: number;
  @IsInt() @Min(0) automated: number;
  @IsIn(['pending', 'partial', 'covered']) status: string;
}

/**
 * Universo de módulos + avance de regresión por cliente. Lo empuja el monorepo
 * (coverage:universe) independiente de una corrida, para que el widget muestre el
 * estado aunque el QA todavía no haya automatizado nada. Se guarda en
 * qa_clients.inventory.universe.
 */
export class IngestUniverseDto {
  @IsString() client_slug: string;
  @IsOptional() @IsString() client_name?: string;
  @IsInt() @Min(0) total_modules: number;
  @IsInt() @Min(0) covered_modules: number;
  @IsInt() @Min(0) pct: number;
  @IsInt() @Min(0) total_stories: number;
  @IsInt() @Min(0) automated_stories: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => UniverseModuleDto)
  modules: UniverseModuleDto[];
}

/** Usuario de prueba del catálogo QA_USERS (.env del cliente). */
class QaUserDto {
  @IsOptional() @IsString() alias?: string;
  @IsString() username: string;
  @IsString() password: string;
  @IsOptional() @IsString() role?: string;
}

/**
 * Credenciales y entornos de un cliente, para el panel del dashboard. Lo empuja
 * el monorepo (qa:creds-sync) leyendo projects/<c>/.env (git-crypt) y los
 * environments de project.meta.json. Se guarda EN CLARO en qa_clients.inventory
 * .credentials (decisión de producto: portal tras login de lista blanca). No
 * pisa el resto del inventario.
 */
export class IngestCredentialsDto {
  @IsString() client_slug: string;
  @IsOptional() @IsString() client_name?: string;
  @IsOptional() @IsString() base_url?: string;
  @IsOptional() @IsString() api_url?: string;
  // Entornos { dev|qa|...: { api?, web?, openapi?, ... } } — forma libre (URLs).
  @IsOptional() @IsObject() environments?: Record<string, Record<string, string>>;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QaUserDto)
  qa_users?: QaUserDto[];
}

/** Un archivo de test con sus títulos (test/describe), para el mapeo IA. */
class TestSignalDto {
  @IsString() file: string;
  @IsArray() @IsString({ each: true }) titles: string[];
}

/**
 * Insumos para que el BACKEND mapee la automatización a los módulos con IA (Gemini).
 * El monorepo manda solo los nombres de módulo (universo) y los títulos de los tests;
 * el backend hace el mapeo (donde vive GEMINI_API_KEY) y guarda la cobertura.
 */
export class IngestUniverseMapDto {
  @IsString() client_slug: string;
  @IsOptional() @IsString() client_name?: string;
  @IsArray() @IsString({ each: true }) modules: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TestSignalDto)
  tests?: TestSignalDto[];
}

export class IngestActivityDto {
  @IsString() actor_login: string;
  @IsIn(['test', 'design', 'bug', 'commit', 'run']) kind: string;
  @IsOptional() @IsString() client_slug?: string;
  @IsString() title: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() ts?: string;
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
}
