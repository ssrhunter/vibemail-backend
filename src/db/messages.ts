import { getServiceClient } from './client';

export interface MessageRow {
  gmail_id: string;
  google_id: string;
  thread_id: string;
  subject: string | null;
  from_address: string | null;
  to_address: string | null;
  snippet: string | null;
  body_plain: string | null;
  body_html: string | null;
  label_ids: string[];
  is_read: boolean;
  is_starred: boolean;
  sent_at: string | null;
}

export async function upsertMessages(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const supabase = getServiceClient();
  const { error } = await supabase.from('messages').upsert(rows, { onConflict: 'gmail_id' });
  if (error) {
    throw new Error(`Failed to upsert messages: ${error.message}`);
  }
}
