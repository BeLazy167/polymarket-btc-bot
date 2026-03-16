import { Effect } from 'effect'

interface Bucket {
  tokens: number
  maxTokens: number
  refillRate: number // tokens per second
  lastRefill: number
}

const buckets = new Map<string, Bucket>()

const BUCKET_CONFIGS: Record<string, { maxTokens: number; refillRate: number }> = {
  gamma: { maxTokens: 1, refillRate: 0.33 },
  data: { maxTokens: 10, refillRate: 3 },
  moondev: { maxTokens: 1, refillRate: 0.1 },
}

function getBucket(name: string): Bucket {
  let bucket = buckets.get(name)
  if (!bucket) {
    const cfg = BUCKET_CONFIGS[name] ?? { maxTokens: 5, refillRate: 1 }
    bucket = { tokens: cfg.maxTokens, maxTokens: cfg.maxTokens, refillRate: cfg.refillRate, lastRefill: Date.now() }
    buckets.set(name, bucket)
  }
  return bucket
}

function refill(bucket: Bucket): void {
  const now = Date.now()
  const elapsed = (now - bucket.lastRefill) / 1000
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate)
  bucket.lastRefill = now
}

/**
 * Acquires a token from the named bucket, waiting if necessary.
 * Returns an Effect that resolves when a token is available.
 */
export const acquireToken = (bucketName: string): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    const tryAcquire = () => {
      const bucket = getBucket(bucketName)
      refill(bucket)
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        resume(Effect.void)
      } else {
        const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000)
        setTimeout(tryAcquire, waitMs)
      }
    }
    tryAcquire()
  })

/**
 * Rate-limited fetch — acquires a token then fetches.
 */
export const rateLimitedFetch = (bucketName: string, url: string, init?: RequestInit): Effect.Effect<Response, Error> =>
  Effect.gen(function* () {
    yield* acquireToken(bucketName)
    return yield* Effect.tryPromise({
      try: () => fetch(url, init),
      catch: (e) => new Error(`Fetch failed [${bucketName}]: ${e}`),
    })
  })
