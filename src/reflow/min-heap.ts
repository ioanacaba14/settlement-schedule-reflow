/**
 * Minimal binary min-heap. Used by topologicalSort to pick the next ready
 * task in O(log n) instead of re-sorting the whole ready queue on every pop
 * (which is what turns an O(n log n) algorithm into an accidental O(n^2 log n)
 * one at scale).
 */
export class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (top === undefined) return undefined;
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i]!, this.items[parent]!) >= 0) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(index: number): void {
    let i = index;
    const n = this.items.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && this.compare(this.items[left]!, this.items[smallest]!) < 0) smallest = left;
      if (right < n && this.compare(this.items[right]!, this.items[smallest]!) < 0) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.items[i]!;
    this.items[i] = this.items[j]!;
    this.items[j] = tmp;
  }
}
