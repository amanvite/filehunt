// custom O(1) LRU cache with automatic TTL expiration so memory usage stays bounded
class LruCache {
  constructor(maxEntries = 200, defaultTtlMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // refresh insertion order for LRU eviction
    this.store.delete(key);
    this.store.set(key, item);
    return item.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  delete(key) {
    this.store.delete(key);
  }
}

module.exports = { LruCache };