export async function mapWithConcurrency(items, concurrency, operation) {
  if (!Array.isArray(items)) throw new Error('Items must be an array.')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.')

  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
