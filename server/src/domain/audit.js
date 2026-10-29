/** Append-only audit trail. Never stores secrets, passwords, API keys or registrant contact details. */
export async function writeAudit(store, config, { dataset, actor, type, summary, details = {}, reason = null }) {
  return store.insert('audit', {
    dataset, ts: config.now().toISOString(), actor: actor?.email || 'system', role: actor?.role || 'system',
    type, summary, details, reason,
  });
}
