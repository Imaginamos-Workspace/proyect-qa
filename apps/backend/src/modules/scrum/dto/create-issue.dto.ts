import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Crear un issue desde el portal → GitHub Issue + ítem del board del cliente.
 *  Validaciones de metodología (descripción/criterios) se aplican en el servicio. */
export class CreateIssueDto {
  @IsString() @IsNotEmpty() @MaxLength(250) title: string;
  @IsString() @IsNotEmpty() type: string; // nombre de la opción Tipo del board (Historia, Bug, …)
  @IsString() @IsNotEmpty() @MaxLength(10_000) description: string;
  @IsOptional() @IsString() @MaxLength(10_000) acceptanceCriteria?: string; // Gherkin — obligatorio en Historia
  @IsOptional() @IsString() @MaxLength(80) area?: string;
  @IsOptional() @IsString() @MaxLength(80) priority?: string;
  @IsOptional() @IsString() @MaxLength(40) estimate?: string; // S/M/L/XL (legacy)
  @IsOptional() @IsInt() @Min(0) points?: number; // story points (campo NUMBER "Puntos")
  @IsOptional() @IsString() @MaxLength(120) sprint?: string; // título de la iteración
  @IsOptional() @IsString() @Matches(YMD, { message: 'Inicio inválido (use YYYY-MM-DD).' }) startDate?: string;
  @IsOptional() @IsString() @Matches(YMD, { message: 'Entrega inválida (use YYYY-MM-DD).' }) dueDate?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(500, { each: true })
  links?: string[]; // adjuntos = URLs
  @IsOptional() @IsInt() @Min(1) parentNumber?: number; // # del issue padre → se enlaza como sub-issue
}

/** Carry-over: mover issues al siguiente sprint (al cerrar uno con pendientes). */
export class CarryOverDto {
  @IsArray() @ArrayMaxSize(500) @IsInt({ each: true }) @Min(1, { each: true }) issues: number[];
}

/** Cambiar las fechas Inicio/Fin de un issue del board (drag-resize del roadmap). */
export class SetDatesDto {
  @IsOptional() @IsString() @Matches(YMD, { message: 'Inicio inválido (YYYY-MM-DD).' }) startDate?: string;
  @IsOptional() @IsString() @Matches(YMD, { message: 'Entrega inválida (YYYY-MM-DD).' }) dueDate?: string;
}
