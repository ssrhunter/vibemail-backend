import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cachedClient = createClient(url, serviceRoleKey);
  return cachedClient;
}
