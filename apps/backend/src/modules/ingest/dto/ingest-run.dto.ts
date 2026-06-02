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

class RunCoverageDto {
  @IsInt() @Min(0) specs_total: number;
  @IsInt() @Min(0) specs_covered: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => CoverageModuleDto)
  modules: CoverageModuleDto[];
}

class IngestTestDto {
  @IsOptional() @IsString() test_id?: string;
  @IsString() title: string;
  @IsOptional() @IsString() file?: string;
  @IsIn(['passed', 'failed', 'skipped', 'flaky']) status: string;
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

export class IngestActivityDto {
  @IsString() actor_login: string;
  @IsIn(['test', 'design', 'bug', 'commit', 'run']) kind: string;
  @IsOptional() @IsString() client_slug?: string;
  @IsString() title: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() ts?: string;
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
}
