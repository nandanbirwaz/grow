/** Collections and their unique indexes (used by both the in-memory and Mongo adapters). */
export const COLLECTIONS = {
  users: { unique: [['email']] },
  settings: { unique: [['dataset']] },
  events: { unique: [['dataset', 'dedupeKey']] },
  registrations: { unique: [['dataset', 'emailHash']] },
  ambassadors: { unique: [['dataset', 'code']] },
  experiments: { unique: [['dataset', 'key']] },
  assignments: { unique: [['dataset', 'experimentKey', 'visitorHash']] },
  spend: { unique: [] },
  drafts: { unique: [] },
  decisions: { unique: [] },
  audit: { unique: [] },
};

export class DuplicateError extends Error {
  constructor(collection, fields) {
    super(`Duplicate key in ${collection}`);
    this.collection = collection;
    this.fields = fields;
  }
}
