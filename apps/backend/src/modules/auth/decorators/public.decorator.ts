import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by SupabaseAuthGuard to detect public routes.
 * Used by @Public() decorator to mark routes as not requiring auth.
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route handler as public — bypasses SupabaseAuthGuard.
 *
 * Use sparingly. Only for endpoints that are intentionally callable without
 * a Supabase session (e.g., self-healing tests run from the user's local
 * machine via a bash script that doesn't carry a session token).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
