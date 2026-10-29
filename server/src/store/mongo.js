import { randomUUID } from 'node:crypto';
import { COLLECTIONS, DuplicateError } from './schema.js';

/**
 * MongoDB adapter (Mongoose, loaded lazily so the app runs without it in dev/test).
 *
 * STATUS: written to the same interface as MemoryStore but NOT exercised by the automated tests
 * in this repository's sandbox (no MongoDB server was available). Run the suite against a real
 * instance before relying on it: MONGODB_URI=... npm test --prefix server (see README).
 */
export async function createMongoStore(uri) {
  let mongoose;
  try {
    mongoose = (await import('mongoose')).default;
  } catch {
    throw new Error('MONGODB_URI is set but the "mongoose" package is not installed. Run: npm install --prefix server');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  const models = {};
  for (const [name, def] of Object.entries(COLLECTIONS)) {
    const schema = new mongoose.Schema({ _id: { type: String, default: () => randomUUID() } }, { strict: false, versionKey: false, collection: name });
    for (const fields of def.unique) {
      schema.index(Object.fromEntries(fields.map((f) => [f, 1])), { unique: true });
    }
    models[name] = mongoose.models[`gh_${name}`] || mongoose.model(`gh_${name}`, schema);
    await models[name].init();
  }

  const strip = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : doc);
  return {
    kind: 'mongo',
    async insert(name, doc) {
      try {
        const created = await models[name].create(doc);
        return strip(created.toObject());
      } catch (e) {
        if (e && e.code === 11000) throw new DuplicateError(name, Object.keys(e.keyPattern || {}));
        throw e;
      }
    },
    async find(name, filter = {}, opts = {}) {
      let q = models[name].find(filter).lean();
      if (opts.sort) q = q.sort(opts.sort);
      if (opts.limit) q = q.limit(opts.limit);
      return strip(await q);
    },
    async findOne(name, filter) {
      return strip(await models[name].findOne(filter).lean());
    },
    async update(name, filter, patch) {
      const r = await models[name].updateMany(filter, { $set: patch });
      return r.modifiedCount;
    },
    async upsert(name, filter, doc) {
      return strip(await models[name].findOneAndUpdate(filter, { $set: doc, $setOnInsert: { _id: randomUUID() } }, { upsert: true, new: true }).lean());
    },
    async deleteMany(name, filter) {
      const r = await models[name].deleteMany(filter);
      return r.deletedCount;
    },
    async count(name, filter = {}) {
      return models[name].countDocuments(filter);
    },
    async close() {
      await mongoose.disconnect();
    },
  };
}
