import { log } from './log.js';

/**
 * Best-effort webhook notification (Discord/Slack/Telegram-bridge style). Never
 * throws — a down webhook must never interrupt mining. Payload is a plain
 * message plus optional structured fields.
 */
export async function notify(webhookUrl: string | undefined, content: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    log.debug('notify failed', { err: String(err) });
  }
}
