import { randomUUID } from 'node:crypto';
import { COLLECTIONS, DuplicateError } from './schema.js';

/**
 * In-memory store. Used for tests and for local development when MONGODB_URI is not set.
 * Filters are equality-only (same contract as the Mongo adapter).
 */
export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.data = Object.fromEntries(Object.keys(COLLECTIONS).map((c) => [c, []]));
  }

  _coll(name) {
    if (!this.data[name]) throw new Error(`Unknown collection ${name}`);
    return this.data[name];
  }
  static _match(doc, filter) {
    return Object.entries(filter).every(([k, v]) => doc[k] === v);
  }

  async insert(name, doc) {
    const coll = this._coll(name);
    for (const fields of COLLECTIONS[name].unique) {
      if (coll.some((d) => fields.every((f) => d[f] === doc[f] && doc[f] !== undefined))) {
        throw new DuplicateError(name, fields);
      }
    }
    const stored = structuredClone({ _id: doc._id || randomUUID(), ...doc });
    coll.push(stored);
    return structuredClone(stored);
  }
  async find(name, filter = {}, opts = {}) {
    let out = this._coll(name).filter((d) => MemoryStore._match(d, filter));
    if (opts.sort) {
      const [[key, dir]] = Object.entries(opts.sort);
      out = [...out].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir);
    }
    if (opts.limit) out = out.slice(0, opts.limit);
    return structuredClone(out);
  }
  async findOne(name, filter) {
    const d = this._coll(name).find((x) => MemoryStore._match(x, filter));
    return d ? structuredClone(d) : null;
  }
  async update(name, filter, patch) {
    let n = 0;
    for (const d of this._coll(name)) {
      if (MemoryStore._match(d, filter)) {
        Object.assign(d, structuredClone(patch));
        n += 1;
      }
    }
    return n;
  }
  async upsert(name, filter, doc) {
    const existing = await this.findOne(name, filter);
    if (existing) {
      await this.update(name, filter, doc);
      return { ...existing, ...doc };
    }
    return this.insert(name, { ...filter, ...doc });
  }
  async deleteMany(name, filter) {
    const coll = this._coll(name);
    const keep = coll.filter((d) => !MemoryStore._match(d, filter));
    const removed = coll.length - keep.length;
    this.data[name] = keep;
    return removed;
  }
  async count(name, filter = {}) {
    return this._coll(name).filter((d) => MemoryStore._match(d, filter)).length;
  }
  async close() {}
}
